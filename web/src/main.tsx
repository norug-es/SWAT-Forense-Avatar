import React from "react";
import { createRoot } from "react-dom/client";
import NeuralAvatarChat from "../../prototipo/NeuralAvatarChat.v.2.2";
import "./styles.css";

function App() {
  return (
    <main className="swat-shell">
      <header className="swat-header">
        <div>
          <p className="eyebrow">SWAT · NEURALBUS</p>
          <h1>Neural Avatar</h1>
          <p className="subtitle">Feed y consultas en tiempo real desde la plataforma SWAT.</p>
        </div>
        <span className="live-pill"><i /> LIVE GATEWAY</span>
      </header>
      <section className="avatar-stage" aria-label="Interfaz pública de SWAT Neural Avatar">
        <NeuralAvatarChat apiBaseUrl="/api/v1" />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
