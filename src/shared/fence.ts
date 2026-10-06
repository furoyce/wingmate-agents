const escapeTags = (t: string) =>
  t.replace(/<[\s/]*untrusted[^>]*>?/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
export function fence(text: string, nonce: string): string {
  const safe = escapeTags(text);
  return `<untrusted nonce="${nonce}">\n${safe}\n</untrusted>`;
}
