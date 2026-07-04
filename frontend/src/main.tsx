import React from "react";
import ReactDOM from "react-dom/client";
import { Workbench } from "./workbench/Workbench";
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-sans/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/geist-mono/latin-600.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Workbench />
  </React.StrictMode>
);
