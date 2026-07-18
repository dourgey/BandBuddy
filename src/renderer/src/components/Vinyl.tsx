export function Vinyl({ artworkUrl, size = 'medium', spinning = false, showFallbackText = true }: { artworkUrl?: string | null; size?: 'tiny' | 'small' | 'medium' | 'large'; spinning?: boolean; showFallbackText?: boolean }): React.JSX.Element {
  return <div className={`vinyl vinyl-${size} ${spinning ? 'is-spinning' : ''}`}>
    <div className="vinyl-grooves" />
    <div className="vinyl-label" style={artworkUrl ? { backgroundImage: `url("${artworkUrl}")` } : undefined}>
      {!artworkUrl && showFallbackText && <span>BB</span>}
      <i />
    </div>
    <div className="vinyl-shine" />
  </div>
}
