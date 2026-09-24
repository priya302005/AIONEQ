"""Dump the trained checkpoint in HuggingFace GPT-2 format so llama.cpp's
convert_hf_to_gguf.py can build a GGUF file for serving (llama-server/llama.cpp).

The module names in model.py already match GPT-2 ('transformer.h.{i}.ln_1',
'attn.c_attn', 'mlp.c_fc', ...), so the state_dict transfers verbatim.

Usage:
  python export_hf.py --ckpt out/ckpt_best.pt --out out-hf
then (see README/chat notes):
  python <llama.cpp>/convert_hf_to_gguf.py out-hf --outfile out/model.gguf --outtype q8_0
"""

import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import ModelConfig


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', default=os.path.join(here, 'out', 'ckpt_best.pt'))
    ap.add_argument('--out', default=os.path.join(here, 'out-hf'))
    args = ap.parse_args()

    body = torch.load(args.ckpt, map_location='cpu')
    cfg = ModelConfig(**body['cfg'])
    sd = body['model']

    os.makedirs(args.out, exist_ok=True)

    eot_id = None
    tok_path = os.path.join(os.path.dirname(args.ckpt), 'tokenizer.json')
    if os.path.exists(tok_path):
        try:
            from tokenizers import Tokenizer
            tok = Tokenizer.from_file(tok_path)
            eot_id = tok.token_to_id('<|endoftext|>')
            vocab = tok.get_vocab()
            merges = getattr(tok.model, 'merges', None)
            with open(os.path.join(args.out, 'tokenizer.json'), 'w', encoding='utf-8') as f:
                f.write(open(tok_path, encoding='utf-8').read())
            if isinstance(vocab, dict):
                with open(os.path.join(args.out, 'vocab.json'), 'w', encoding='utf-8') as f:
                    json.dump(vocab, f, ensure_ascii=False)
            if merges is not None:
                with open(os.path.join(args.out, 'merges.txt'), 'w', encoding='utf-8') as f:
                    f.write('\n'.join(f'{a} {b}' for a, b in merges))
        except ImportError:
            print('Could not read tokenizer.json (tokenizers not installed). '
                  'GGUF conversion may still work with vocab.json/merges.txt.')
    else:
        print('WARNING: no tokenizer.json found next to the checkpoint. '
              'Character-level checkpoints are NOT GGUF-exportable; '
              'retrain with `pip install tokenizers` for a servable model.')

    config = {
        'architectures': ['GPT2LMHeadModel'],
        'model_type': 'gpt2',
        'vocab_size': cfg.vocab_size,
        'n_embd': cfg.n_embd,
        'n_head': cfg.n_head,
        'n_layer': cfg.n_layer,
        'n_positions': cfg.block_size,
        'n_ctx': cfg.block_size,
        'n_inner': 4 * cfg.n_embd,
        'layer_norm_epsilon': 1e-5,
        'initializer_range': 0.02,
        'resid_pdrop': cfg.dropout,
        'embd_pdrop': cfg.dropout,
        'attn_pdrop': cfg.dropout,
        'tie_word_embeddings': True,
        'eos_token_id': eot_id,
        'bos_token_id': eot_id,
    }
    if eot_id is not None:
        config['pad_token_id'] = eot_id

    with open(os.path.join(args.out, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)

    # GPT-2 key layout (matches our module names already)
    renamed = {}
    for k, v in sd.items():
        renamed[k] = v
    torch.save(renamed, os.path.join(args.out, 'pytorch_model.bin'))

    print(f'Exported HF checkpoint to {args.out}')
    print('Next: clone llama.cpp, then run:')
    print(f'  python <llama.cpp>/convert_hf_to_gguf.py {args.out} --outfile {here}/out/model.gguf --outtype q8_0')
    print('Then serve with llama-server and point LOCAL_AI_BASE_URL at it.')


if __name__ == '__main__':
    main()