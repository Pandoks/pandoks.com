import { error } from '@sveltejs/kit';
import type { Picture } from '@sveltejs/enhanced-img';
import type { EntryGenerator, PageLoad } from './$types';
import type { Post } from '$lib/blog/types';

export const prerender = true;

const posts = Object.fromEntries(
  Object.entries(import.meta.glob<Post>('/src/lib/blog/*.json', { import: 'default' })).map(
    ([path, importer]) => [path.split('/').pop()!.split('.')[0], importer]
  )
);
const images = Object.fromEntries(
  Object.entries(
    import.meta.glob<Picture>('/src/lib/blog/images/*.{png,jpg,jpeg,webp,avif,gif}', {
      query: { enhanced: true },
      import: 'default'
    })
  ).map(([path, importer]) => [path.split('/').pop()!, importer])
);

export const entries: EntryGenerator = () => Object.keys(posts).map((slug) => ({ title: slug }));

export const load: PageLoad = async ({ params }) => {
  const postImporter = posts[params.title];
  if (!postImporter) error(404);
  const post = await postImporter();

  const blocks = await Promise.all(
    post.blocks.map(async (block) => {
      if (block.type !== 'image') return block;

      const image = images[block.filename];
      if (!image) error(500, `image not found: ${block.filename}`);

      return { ...block, picture: await image() };
    })
  );
  return { ...post, blocks };
};
