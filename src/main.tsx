import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import FloatingWidget from "./widget/FloatingWidget";
import "./styles/app.css";

type TauriInternals = { metadata: { currentWindow: { label: string } } };

const windowLabel = "__TAURI_INTERNALS__" in window
  ? (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__.metadata.currentWindow.label
  : "main";

document.documentElement.dataset.window = windowLabel;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {windowLabel === "floating-widget" ? <FloatingWidget /> : <App />}
  </StrictMode>,
);
