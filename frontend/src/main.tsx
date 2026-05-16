import React from "react";
import ReactDOM from "react-dom/client";
import { Workbench } from "./workbench/Workbench";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Workbench />
  </React.StrictMode>
);
