import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeCanvasLifecycleRuntime } from "./components/display";
import "./styles/globals.css";

initializeCanvasLifecycleRuntime();

window.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
