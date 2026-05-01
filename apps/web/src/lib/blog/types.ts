export type RichText = {
  plain_text: string;
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  href: string | null;
};

export type BlogBlock =
  | { type: 'break' }
  | { type: 'paragraph' | 'heading_1' | 'heading_2' | 'heading_3'; texts: RichText[] }
  | { type: 'image'; filename: string }
  | { type: 'code'; code: string; language: string };

export type Post = { title: string; createdTime: string; blocks: BlogBlock[] };
