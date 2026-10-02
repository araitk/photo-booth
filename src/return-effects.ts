export function returnKeyframes(source: DOMRect, target: DOMRect): Keyframe[] {
  const x = target.left + target.width / 2 - source.left - source.width / 2;
  const y = target.top + target.height / 2 - source.top - source.height / 2;
  const scale = Math.min(target.width / Math.max(source.width, 1), target.height / Math.max(source.height, 1), 1);
  return [
    { opacity: 1, transform: 'translate(0, 0) scale(1)', borderRadius: '0px', offset: 0 },
    { opacity: 1, transform: `translate(${x}px, ${y}px) scale(${scale})`, borderRadius: '12px', offset: 1 },
  ];
}
