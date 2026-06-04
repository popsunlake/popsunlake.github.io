const STORAGE_KEY = "zcw-namecard-theme";
const themeButtons = document.querySelectorAll("[data-theme-value]");
const supportedThemes = ["light", "swan", "sport", "night"];

function applyTheme(theme) {
  const nextTheme = supportedThemes.includes(theme) ? theme : "light";
  document.body.dataset.theme = nextTheme;

  themeButtons.forEach((button) => {
    const isActive = button.dataset.themeValue === nextTheme;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  localStorage.setItem(STORAGE_KEY, nextTheme);
}

const savedTheme = localStorage.getItem(STORAGE_KEY);
applyTheme(savedTheme || "light");

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyTheme(button.dataset.themeValue);
  });
});
