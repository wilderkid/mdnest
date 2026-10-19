// Small inline SVG icons for the sidebar footer. Stroke icons, currentColor, 16×16.
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  newFile: svg(`<path d="M4 2.5h5.2L12.5 5.8V13.5H4z"/><path d="M9 2.5V6h3.5"/><path d="M8 8.2v4"/><path d="M6 10.2h4"/>`),
  newFolder: svg(`<path d="M2 4.2h4.2l1.2 1.4H14v7.2H2z"/><path d="M8 7.6v3.6"/><path d="M6.2 9.4h3.6"/>`),
  openFolder: svg(`<path d="M2 5h4l1.2 1.3H14v6.2H2z"/><path d="M6.2 9.2h3.6"/><path d="M8.6 7.8l1.6 1.4-1.6 1.4"/>`),
  sort: svg(`<path d="M3.5 4h9"/><path d="M5 8h6"/><path d="M6.5 12h3"/>`),
  search: svg(`<circle cx="7" cy="7" r="3.4"/><path d="M9.6 9.6L13 13"/>`),
  refresh: svg(`<path d="M13 8a5 5 0 1 1-1.4-3.5"/><path d="M13 2.8V6h-3.2"/>`),
};

export function iconButton(act: string, title: string, icon: string, extra = ""): string {
  return `<button type="button" data-act="${act}" title="${title}" aria-label="${title}"${extra}>${icon}</button>`;
}
