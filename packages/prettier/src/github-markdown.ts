import { doc, type AstPath, type ParserOptions, type Plugin, type Printer } from 'prettier';
import {
  parsers as markdownParsers,
  printers as markdownPrinters
} from 'prettier/plugins/markdown';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset: number } };
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
    String.raw`^:[\w+-]+:`,
    String.raw`^\[\^[^\]\s]+\]:`,
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

const nextLineStart = (
  { index, ancestors: [sentence, parent] }: AstPath<MarkdownNode>,
  { originalText }: ParserOptions<MarkdownNode>
) => {
  let text = '';
  for (const node of sentence?.children?.slice((index ?? 0) + 1) ?? []) {
    if (node.type === 'whitespace') return text;
    text += node.value ?? '';
  }
  const siblings = parent?.children ?? [];
  const offset = siblings[siblings.indexOf(sentence) + 1]?.position?.start.offset;
  return offset === undefined ? text : text + originalText.slice(offset).split('\n', 1)[0];
};

const endsWithEscape = (node: MarkdownNode | null) =>
  /(?:^|[^\\])(?:\\\\)*\\$/.test(node?.value ?? '');

export default {
  parsers: { markdown: { ...markdownParsers.markdown, astFormat } },
  printers: {
    [astFormat]: {
      ...mdast,
      print(path, options, print, args) {
        const { node } = path;
        if (node.type !== 'whitespace' || options.proseWrap === 'preserve') {
          return mdast.print(path, options, print, args);
        }
        if (isAfterAlertMarker(path)) {
          return node.value === '\n' ? doc.builders.hardline : ' ';
        }
        if (unsafeLineStart.test(nextLineStart(path, options)) || endsWithEscape(path.previous)) {
          return mdast.print(path, { ...options, proseWrap: 'never' }, print, args);
        }
        return mdast.print(path, options, print, args);
      }
    }
  }
} satisfies Plugin<MarkdownNode>;
