import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/dm-sans/latin-700.css";
import "@fontsource/dm-sans/latin-800.css";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/manrope/latin-800.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import React from "react";
import { createRoot } from "react-dom/client";
const App =
  new URLSearchParams(window.location.search).get("lab") === "1"
    ? (await import("./lab.js")).default
    : (await import("./operations.js")).default;
createRoot(document.getElementById("root")!).render(<App />);
