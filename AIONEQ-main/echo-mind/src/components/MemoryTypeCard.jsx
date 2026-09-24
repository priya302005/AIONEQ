function MemoryTypeCard({ memoryType, onSelect, count }) {
  return (
    <button type="button" className="memory-card" onClick={() => onSelect(memoryType.type)}>
      <span className="memory-icon">{<memoryType.Icon />}</span>
      <h3>{memoryType.title}</h3>
      <p>{memoryType.desc}</p>
      {count !== undefined && (
        <span className="memory-count">{count} saved</span>
      )}
    </button>
  )
}

export default MemoryTypeCard