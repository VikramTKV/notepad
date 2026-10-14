// Fills the Privacy and Terms pages from config.js (brand, operator, contact, governing law).
(() => {
  "use strict";
  const c = window.QUILLNOTE_CONFIG || {};
  const brand = c.brandName || "Quillnote";
  const operator = c.operatorName || `the operator of ${brand}`;
  document.querySelectorAll("[data-brand]").forEach(el => { el.textContent = brand; });
  document.querySelectorAll("[data-operator]").forEach(el => { el.textContent = operator; });
  document.querySelectorAll("[data-year]").forEach(el => { el.textContent = new Date().getFullYear(); });
  document.title = document.title.replace("Quillnote", brand);
  document.querySelectorAll("[data-contact]").forEach(el => {
    if (c.contactEmail) {
      const a = document.createElement("a");
      a.href = `mailto:${c.contactEmail}`;
      a.textContent = c.contactEmail;
      el.textContent = "";
      el.append("Email ", a, ".");
    }
  });
  const law = document.getElementById("law");
  if (law) {
    if (c.governingLaw) law.textContent = `These terms are governed by the laws of ${c.governingLaw}, and disputes will be handled by the courts there, unless the law where you live gives you the right to use your local courts.`;
    else law.hidden = true;
  }
})();
