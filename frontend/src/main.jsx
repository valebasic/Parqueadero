import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { SessionProvider } from './context/SessionContext.jsx';
import { ShiftProvider } from './context/ShiftContext.jsx';
import { ReceiptProvider } from './components/Receipt.jsx';
import './styles/theme.css';
import './styles/layout.css';
import './styles/operation.css';
import './styles/management.css';
import './styles/receipt.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ShiftProvider>
          <ReceiptProvider>
            <App />
          </ReceiptProvider>
        </ShiftProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
