import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  important: true,
  theme: {
    extend: {
      colors: { primary: "#5b5bd6" },
    },
  },
  plugins: [],
} satisfies Config;
