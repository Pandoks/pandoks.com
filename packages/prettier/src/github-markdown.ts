import { doc, type AstPath, type Doc, type Plugin } from 'prettier';
import { parsers, printers } from 'prettier/plugins/markdown';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

const { mdast } = printers;

const ALERT_MARKER = /^\[!(?:note|tip|important|warning|caution)\]$/i;

// type 6 block tags from both GFM (cmark-gfm) and CommonMark 0.31
const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// line starts that change how GitHub renders a paragraph but prettier doesn't already avoid
const UNSAFE_LINE_START = new RegExp(
  [
    String.raw`^(?:\x60{3,}|~{3,}|\$\$|[>|]|\{[{%]|<[!?])`,
    String.raw`^(?:=+|:?-+:?|_+|\*+)(?:[\s|]|$)`,
    String.raw`^\**:[\w+-]+:`,
    String.raw`^\[\^[^\]]+\]:`,
    String.raw`^(?:\+|#{1,6}|0{0,8}1[.)])\s`,
    String.raw`^<(?:script|pre|style|textarea)(?:[\s>]|$)`,
    String.raw`^</?(?:${HTML_BLOCK_TAGS})(?:[\s/>]|$)`
  ].join('|'),
  'i'
);

// where a line has to start (a paragraph or a hard break), the text before a break mustn't form a
// block on its own, and a lone list marker there mustn't be joined with the next word
const BLOCK_LINE =
  /^(?:[-*_=:|\s]+|\x60{3,}[^\x60]*|\${2,}[^$]*|<\/?[a-z](?:[^<>"']|"[^"]*"|'[^']*')*>|\{[{%].*[%}]\})$/is;
const LIST_MARKER = /^(?:[*+]|1[.)])$/;
// the paragraph so far mustn't end like a link reference definition
const LINK_DEFINITION =
  /^\[(?:\\.|[^\\\]])+\]:[ \t\n]*(?:(?:<(?:\\.|[^\\>])*>|[^ \t\n]+)(?:[ \t\n]+["'(].*["')])?)?$/s;

const isAfterAlertMarker = ({ node, ancestors: [sentence, , blockquote] }: AstPath<MarkdownNode>) =>
  blockquote.type === 'blockquote' &&
  blockquote.children?.[0].children?.[0]?.children?.[1] === node &&
  ALERT_MARKER.test(sentence.children?.[0].value ?? '');

const isUnsafeBreak = (paragraph: string, before: string, after: string, quoted: boolean) =>
  LINK_DEFINITION.test(paragraph) ||
  BLOCK_LINE.test(before) ||
  UNSAFE_LINE_START.test(after) ||
  // GitHub garbles `[^…]` text that contains a line break, e.g. `[^a\nb]` renders as `[^]`, and
  // prettier prints reference labels from the source; wrapped in a blockquote they gain a `>` word
  ((quoted ? /\[(?:\[[^[\]]*\]|[^[\]])*$/ : /\[\^(?:\[[^[\]]*\]|\[(?!\^)|[^[\]])*$/).test(before) &&
    after.includes(']')) ||
  before.endsWith('\\');

const flatText = (printed: Doc) =>
  doc.printer.printDocToString(doc.builders.group(printed), { printWidth: Infinity, tabWidth: 0 })
    .formatted;

const keepUnsafeBreaksJoined = ({ parts }: doc.builders.Fill, quoted: boolean) => {
  const texts = parts.map(flatText);
  const text = texts.join('');
  const joined: Doc[] = [''];
  let lineStart = 0;
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    const paragraph = text.slice(0, offset);
    const before = paragraph.slice(lineStart);
    offset += texts[index].length;
    if (index % 2 === 0) {
      joined.push([joined.pop()!, part]);
      if (texts[index].includes('\n')) lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    } else if (texts[index] === '\n' || LIST_MARKER.test(before)) {
      joined.push(doc.builders.hardline, '');
      lineStart = offset;
    } else if (isUnsafeBreak(paragraph, before, text.slice(offset), quoted)) {
      joined.push([joined.pop()!, texts[index]]);
    } else {
      joined.push(part, '');
    }
  }
  return doc.builders.fill(joined);
};

export default {
  parsers: { markdown: { ...parsers.markdown } },
  printers: {
    mdast: {
      ...mdast,
      embed(path, options) {
        const embed = mdast.embed!(path, options);
        if (typeof embed !== 'function') return embed;
        return (textToDocument, ...rest) =>
          embed((text, next) => textToDocument(text, { ...next, proseWrap: 'preserve' }), ...rest);
      },
      print(path, options, print, args) {
        const { node } = path;
        if (node.type === 'whitespace' && isAfterAlertMarker(path)) {
          return node.value === '\n' ? doc.builders.hardline : node.value!;
        }
        if (node.type === 'definition' || path.ancestors.some(({ type }) => type === 'heading')) {
          return mdast.print(path, { ...options, proseWrap: 'preserve' }, print, args);
        }
        const printed = mdast.print(path, options, print, args);
        if (node.type !== 'paragraph') return printed;
        const quoted = path.ancestors.some(({ type }) => type === 'blockquote');
        return keepUnsafeBreaksJoined(printed as doc.builders.Fill, quoted);
      }
    }
  }
} satisfies Plugin<MarkdownNode>;
