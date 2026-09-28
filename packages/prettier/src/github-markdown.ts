import { doc, type AstPath, type Doc, type Plugin, type Printer } from 'prettier';
import {
  parsers as markdownParsers,
  printers as markdownPrinters
} from 'prettier/plugins/markdown';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const astFormat = 'mdast-github';
const mdast = markdownPrinters.mdast as Printer<MarkdownNode>;

const alertMarker = /^\[!(?:note|tip|important|warning|caution)\]$/i;

// type 6 block tags from both GFM (cmark-gfm) and CommonMark 0.31
const htmlBlockTags =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// line starts that change how GitHub renders a paragraph but prettier doesn't already avoid
const unsafeLineStart = new RegExp(
  [
    String.raw`^(?:\x60{3,}|~{3,}|\$\$)`,
    String.raw`^(?:=+|:?-+:?|_+|\*+)(?:\s|$)`,
    String.raw`^\|`,
    String.raw`^[*_~]*:[\w+-]+:`,
    String.raw`^\[\^[^\]]+\]:`,
    String.raw`^<(?:script|pre|style|textarea)(?:[\s>]|$)`,
    String.raw`^<(?:!--|\?|![a-z]|!\[CDATA\[)`,
    String.raw`^</?(?:${htmlBlockTags})(?:[\s/>]|$)`
  ].join('|'),
  'i'
);

const isAfterAlertMarker = ({
  index,
  ancestors: [sentence, paragraph, blockquote]
}: AstPath<MarkdownNode>) =>
  index === 1 &&
  alertMarker.test(sentence?.children?.[0]?.value ?? '') &&
  paragraph?.children?.[0] === sentence &&
  blockquote?.type === 'blockquote' &&
  blockquote.children?.[0] === paragraph;

const isUnsafeBreak = (before: string, after: string) =>
  unsafeLineStart.test(after) ||
  // GitHub garbles `[^…]` text that contains a line break, e.g. `[^a\nb]` renders as `[^]`
  (/\[\^[^\]]*$/.test(before) && after.includes(']')) ||
  /(?:^|[^\\])(?:\\\\)*\\$/.test(before);

type Token = string | null | { parts: Doc[]; index: number; soft: boolean };

const tokenize = (printed: Doc, tokens: Token[] = []): Token[] => {
  if (typeof printed === 'string') {
    tokens.push(printed);
  } else if (Array.isArray(printed)) {
    for (const part of printed) tokenize(part, tokens);
  } else if (printed.type === 'fill') {
    for (const [index, part] of printed.parts.entries()) {
      if (
        index % 2 === 1 &&
        !Array.isArray(part) &&
        typeof part === 'object' &&
        part.type === 'line' &&
        !part.hard
      ) {
        tokens.push({ parts: printed.parts, index, soft: Boolean(part.soft) });
      } else {
        tokenize(part, tokens);
      }
    }
  } else if (printed.type === 'line') {
    tokens.push(printed.hard ? null : printed.soft ? '' : ' ');
  } else if (printed.type === 'if-break') {
    tokenize(printed.flatContents, tokens);
  } else if ('contents' in printed) {
    tokenize(printed.contents, tokens);
  }
  return tokens;
};

const joinTokens = (tokens: Token[]) =>
  tokens.map((token) => (typeof token === 'string' ? token : token?.soft ? '' : ' ')).join('');

// decide on the printed text so delimiters, escapes and emphasis styles match the output
const keepUnsafeBreaksJoined = (printed: Doc) => {
  const tokens = tokenize(printed);
  let lineStart = 0;
  for (const [index, token] of tokens.entries()) {
    if (token === null) lineStart = index + 1;
    if (!token || typeof token === 'string') continue;
    const lineEnd = tokens.indexOf(null, index);
    const before = joinTokens(tokens.slice(lineStart, index));
    const after = joinTokens(tokens.slice(index + 1, lineEnd === -1 ? undefined : lineEnd));
    if (isUnsafeBreak(before, after)) token.parts[token.index] = token.soft ? '' : ' ';
  }
  return printed;
};

export default {
  parsers: { markdown: { ...markdownParsers.markdown, astFormat } },
  printers: {
    [astFormat]: {
      ...mdast,
      print(path, options, print, args) {
        const { node } = path;
        if (options.proseWrap === 'preserve') return mdast.print(path, options, print, args);
        if (node.type === 'whitespace' && isAfterAlertMarker(path)) {
          return node.value === '\n' ? doc.builders.hardline : ' ';
        }
        const printed = mdast.print(path, options, print, args);
        return node.type === 'paragraph' ? keepUnsafeBreaksJoined(printed) : printed;
      }
    }
  }
} satisfies Plugin<MarkdownNode>;
