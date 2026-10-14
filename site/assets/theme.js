// Runs before the stylesheet so the saved theme applies on first paint (no flash of the wrong colours).
// Kept as a file rather than inline so the Content Security Policy can forbid inline scripts.
try {
  var t = localStorage.getItem("quillnote.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) { /* storage blocked: follow the system theme */ }
