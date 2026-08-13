export function getBlogBoundaries(activeIndex: number | undefined, blogCount: number) {
  return {
    bodyTop: activeIndex === 0,
    bodyBottom: activeIndex === blogCount - 1
  };
}
