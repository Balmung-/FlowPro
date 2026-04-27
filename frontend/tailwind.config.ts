import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#f8fafc",
        ink: "#0f172a",
        edge: "#cbd5e1",
        accent: "#14532d"
      }
    }
  },
  plugins: []
};

export default config;

