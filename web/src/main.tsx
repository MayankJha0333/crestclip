import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import '@fontsource-variable/fredoka';
import '@fontsource-variable/nunito';
// caption preview fonts (same as the renderer)
import '@fontsource/anton';
import '@fontsource/bangers';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/800.css';
import './styles/index.css';
import { router } from './app/router';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
