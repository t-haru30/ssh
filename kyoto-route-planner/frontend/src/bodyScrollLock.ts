let locks = 0;
let previous = "";
export function lockBodyScroll() {
  if (locks++ === 0) { previous = document.body.style.overflow; document.body.style.overflow = "hidden"; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) document.body.style.overflow = previous;
  };
}
