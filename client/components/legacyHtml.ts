import TurndownService from 'turndown';

// Older task descriptions were saved as HTML by the previous rich-text editor. They always start
// with a block tag; Markdown that merely mentions a tag (`List<String>`) does not.
export const isLegacyHtml = (value: string) => /^\s*<(p|h[1-6]|ul|ol|li|img|blockquote|pre|div|hr|br|strong|em|a|table)[\s>/]/i.test(value);

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });

// Tables become GFM tables (turndown alone flattens every cell into its own paragraph). A cell
// is one line: inner line breaks become spaces and a literal | is escaped.
const cellText = (content: string) => content.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => ` ${cellText(content)} |`,
});
turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content, node) => {
    const row = `|${content}\n`;
    // The delimiter row goes under the first row of the table, which is its header
    const table = (node as HTMLElement).closest('table');
    if (!table || table.querySelector('tr') !== node) return row;
    const cells = (node as HTMLElement).querySelectorAll('th, td').length;
    return row + `|${' --- |'.repeat(cells)}\n`;
  },
});
turndown.addRule('tableSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: (content) => content });
turndown.addRule('table', { filter: 'table', replacement: (content) => `\n\n${content.trim()}\n\n` });

export const htmlToMarkdown = (html: string) => turndown.turndown(html);

// Text for the Markdown editor: legacy HTML is converted once, Markdown is kept as is.
export const toMarkdown = (value: string) => (isLegacyHtml(value) ? htmlToMarkdown(value) : value);
