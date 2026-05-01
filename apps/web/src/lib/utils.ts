export const getSlugFromBlogTitle = (title: string): string => {
  return title.replaceAll(' ', '-').toLowerCase();
};
