/** Triggers a browser download from a string. Used by the viewer and the options page. */
export function downloadText(filename: string, content: string, type = 'text/plain'): void {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
