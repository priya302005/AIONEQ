"""Train a tiny GPT completely from scratch on:
  - TinyStories (coherent language ability) https://huggingface.co/datasets/roneneldan/TinyStories
  - your personal texts  (data/memories.txt)

Everything is self-contained: BPE tokenizer (or character fallback), GPT model
from model.py, a from-scratch training loop, checkpointing and sampling.

Usage:
  python train.py                    # full run (moderate, ~1-3h on CPU)
  python train.py --quick            # tiny smoke run (~5-15 min) to validate
  python train.py --steps 1000 --help
"""

import argparse
import json
import math
import os
import random
import sys
import time
import urllib.request

import torch

# make `import model` work whether run as `python train.py` inside llm/ or elsewhere
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import GPT, ModelConfig

STORIES_URL = 'https://huggingface.co/datasets/roneneldan/TinyStories/resolve/main/TinyStoriesV2-GPT4-valid.txt'
STORIES_FILE = 'TinyStoriesV2-GPT4-valid.txt'
EOT = '<|endoftext|>'


# ---------------------------------------------------------------- data prep ---
def ensure_stories(data_dir, download_ok):
    path = os.path.join(data_dir, STORIES_FILE)
    if os.path.exists(path):
        return path
    if not download_ok:
        print(f'NOT FOUND: {path}. Re-run without --no-download to fetch it automatically.')
        return None
    print(f'Downloading TinyStories from HF ({STORIES_URL}) ...')
    urllib.request.urlretrieve(STORIES_URL, path)
    print('Done.')
    return path


def build_text(data_dir, max_chars_stories, download_ok):
    pieces = []
    story_path = ensure_stories(data_dir, download_ok)
    if story_path:
        with open(story_path, 'r', encoding='utf-8', errors='ignore') as f:
            text = f.read()
        pieces.append(text[:max_chars_stories])
    mem_path = os.path.join(data_dir, 'memories.txt')
    if os.path.exists(mem_path):
        with open(mem_path, 'r', encoding='utf-8', errors='ignore') as f:
            mem = f.read().strip()
        if mem:
            pieces.append(f'{EOT}\n=== MY MEMORIES ===\n{mem}')
    if not pieces:
        print('No data found. Drop your personal texts in llm/data/memories.txt and/or allow the story download.')
        sys.exit(1)
    return '\n\n'.join(pieces)


# ------------------------------------------------------------- tokenizer ------
def make_tokenizer(text, n_vocab, out_dir):
    try:
        from tokenizers import Tokenizer, models, trainers, pre_tokenizers, decoders
        tok = Tokenizer(models.BPE())
        tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
        tok.decoder = decoders.ByteLevel()
        trainer = trainers.BpeTrainer(vocab_size=n_vocab, special_tokens=[EOT], min_frequency=2)
        tok.train_from_iterator(_chunks(text), trainer)
        tok.save(os.path.join(out_dir, 'tokenizer.json'))

        class Wrap:
            def __init__(self):
                self.vocab_size = len(tok.get_vocab())
            def encode(self, s):
                return tok.encode(s).ids
            def decode(self, ids):
                return tok.decode(list(ids))
            def is_bpe(self):
                return True
        return Wrap()
    except ImportError:
        print('NOTE: `tokenizers` not installed -> using character-level tokenizer. '
              'Run `pip install tokenizers` for better quality.')
        return _char_tokenizer(text, out_dir)


def _chunks(text, size=1_000_000):
    for i in range(0, len(text), size):
        yield text[i:i + size]


def _char_tokenizer(text, out_dir):
    vocab = sorted(set(text)) + [EOT]
    stoi = {c: i for i, c in enumerate(vocab)}
    itos = {i: c for c, i in stoi.items()}

    class Wrap:
        def __init__(self):
            self.vocab_size = len(vocab)
        def encode(self, s):
            return [stoi[c] for c in s]
        def decode(self, ids):
            return ''.join(itos[i] for i in ids)
        def is_bpe(self):
            return False

    with open(os.path.join(out_dir, 'char_vocab.json'), 'w', encoding='utf-8') as f:
        json.dump(stoi, f, ensure_ascii=False)
    return Wrap()


def encode_corpus(text, tok, block_size):
    ids = tok.encode(text)
    return torch.tensor(ids, dtype=torch.long)


# ------------------------------------------------------------------ optimizer --
def adamw(params, lr, betas=(0.9, 0.95), eps=1e-8, weight_decay=0.1):
    optim_groups = []
    for p in params:
        if p.ndim < 2:
            optim_groups.append({'params': [p], 'weight_decay': 0.0})
        else:
            optim_groups.append({'params': [p], 'weight_decay': weight_decay})
    return torch.optim.AdamW(optim_groups, lr=lr, betas=betas, eps=eps)


def lr_at(step, warmup, total, peak):
    if step < warmup:
        return peak * step / max(warmup, 1)
    t = (step - warmup) / max(total - warmup, 1)
    t = min(max(t, 0.0), 1.0)
    return peak * 0.5 * (1.0 + math.cos(math.pi * t))


# ------------------------------------------------------------------- training --
def get_batch(split, data, block_size, batch_size, device):
    t = data[split]
    seq = min(block_size, len(t) - 2)
    if seq < 1:
        raise ValueError(f'{split} split too small for block-size {block_size} (len={len(t)})')
    ix = torch.randint(len(t) - seq - 1, (batch_size,))
    x = torch.stack([t[i:i + seq] for i in ix])
    y = torch.stack([t[i + 1:i + 1 + seq] for i in ix])
    return x.to(device), y.to(device)


@torch.no_grad()
def estimate_loss(model, data, block_size, batch_size, device, eval_iters=30):
    model.eval()
    out = {}
    for split in ('train', 'val'):
        loss = 0.0
        for _ in range(eval_iters):
            x, y = get_batch(split, data, block_size, batch_size, device)
            _, l = model(x, y)
            loss += l.item()
        out[split] = loss / eval_iters
    model.train()
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', default=os.path.join(here, 'data'))
    ap.add_argument('--out-dir', default=os.path.join(here, 'out'))
    ap.add_argument('--no-download', action='store_true', help='skip downloading TinyStories')
    ap.add_argument('--quick', action='store_true', help='tiny settings for a fast validation run')
    ap.add_argument('--max-chars', type=int, default=20_000_000, help='stories bytes cap (CPU bound)')
    ap.add_argument('--vocab', type=int, default=4096, help='BPE vocab size (ignored for char mode)')
    ap.add_argument('--steps', type=int, default=3000)
    ap.add_argument('--batch-size', type=int, default=16)
    ap.add_argument('--block-size', type=int, default=256)
    ap.add_argument('--n-layer', type=int, default=6)
    ap.add_argument('--n-head', type=int, default=6)
    ap.add_argument('--n-embd', type=int, default=384)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--warmup', type=int, default=200)
    ap.add_argument('--grad-clip', type=float, default=1.0)
    ap.add_argument('--seed', type=int, default=1337)
    args = ap.parse_args()

    if args.quick:
        args.steps, args.batch_size, args.block_size = 200, 8, 128
        args.max_chars = 1_500_000
        args.warmup = 20
        args.vocab = 2048
        args.n_layer, args.n_head, args.n_embd = 4, 4, 192

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    os.makedirs(args.data_dir, exist_ok=True)
    os.makedirs(args.out_dir, exist_ok=True)

    text = build_text(args.data_dir, args.max_chars, not args.no_download)
    tok = make_tokenizer(text, args.vocab, args.out_dir)
    print(f'corpus chars: {len(text):,}')

    raw = encode_corpus(text, tok, args.block_size)
    n = int(0.98 * len(raw))
    data = {'train': raw[:n], 'val': raw[n:]}
    print(f'tokens: train={len(data["train"]):,} val={len(data["val"]):,}')

    cfg = ModelConfig(vocab_size=tok.vocab_size, block_size=args.block_size,
                      n_layer=args.n_layer, n_head=args.n_head, n_embd=args.n_embd)
    model = GPT(cfg).to(device)
    print(f'model params: {model.num_parameters():,}')

    optimizer = adamw(model.parameters(), lr=args.lr)
    print('training on device:', device)

    start = time.time()
    best_val = float('inf')
    for step in range(1, args.steps + 1):
        x, y = get_batch('train', data, args.block_size, args.batch_size, device)
        logits, loss = model(x, y)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        for g in optimizer.param_groups:
            g['lr'] = lr_at(step, args.warmup, args.steps, args.lr)
        optimizer.step()

        if step % 50 == 0 or step == args.steps:
            el = (time.time() - start) / step
            print(f'step {step:5d}/{args.steps} loss {loss.item():.4f}  ~{el:.1f}s/step  '
                  f'eta {el * (args.steps - step) / 60:.1f}min')

        if step % 250 == 0 or step == args.steps:
            stats = estimate_loss(model, data, args.block_size, args.batch_size, device)
            print(f'  train {stats["train"]:.4f} val {stats["val"]:.4f}')
            if stats['val'] < best_val:
                best_val = stats['val']
                torch.save({'cfg': cfg.to_dict(), 'model': model.state_dict()},
                           os.path.join(args.out_dir, 'ckpt_best.pt'))
                print('  saved best checkpoint ckpt_best.pt')

    ckpt = {'cfg': cfg.to_dict(), 'model': model.state_dict()}
    torch.save(ckpt, os.path.join(args.out_dir, 'ckpt.pt'))
    print('saved final checkpoint ckpt.pt')

    print('\n--- sample ---')
    prompts = ['Once upon a time', 'One day', EOT]
    for p in prompts:
        try:
            pid = torch.tensor([tok.encode(p)], dtype=torch.long, device=device)
            out = model.generate(pid, max_new_tokens=200, temperature=0.8, top_k=50)
            print('>>', p, tok.decode(out[0].tolist()))
        except Exception as e:
            print('sample failed:', e)
    print('\nDone. Checkpoints + tokenizer are in llm/out. Next: export with export_hf.py')


if __name__ == '__main__':
    main()