// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
    redirects: {
        "/perform": "https://forms.gle/F5HCWt6P7pZDd4ew9",
        "/host": "https://forms.gle/5DRSttNLzSgi3pxh8",
        "/volunteer": "https://forms.gle/HB6YgTvMBpBNP4C27",
        "/vendor": "https://forms.gle/MkC37SUAtQ6S4CE86",
    },
    vite: {
        plugins: [tailwindcss()],
    },
});
