/** Where the browser keeps someone's Light/Dark choice (no entry = follow the computer). */
export const THEME_STORAGE_KEY = "tohyee.theme";

/**
 * Runs in <head> before the first paint: puts a saved Light or Dark choice on
 * <html> as data-theme, so the page never flashes the wrong theme. Anything
 * else (or storage being blocked) leaves it to the computer's setting.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
