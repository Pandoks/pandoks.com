export function hasBlogNavigation(blogCount: number) {
  return blogCount > 0;
}

export function getBlogBoundaries(activeIndex: number | undefined, blogCount: number) {
  return {
    bodyTop: blogCount === 0 || activeIndex === 0,
    bodyBottom: blogCount === 0 || activeIndex === blogCount - 1
  };
}
