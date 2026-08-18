import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';

import { auth } from './api.ts';
import Dashboard from './pages/Dashboard.tsx';
import JobDetail from './pages/JobDetail.tsx';
import SignIn from './pages/SignIn.tsx';
import WorkOrders from './pages/WorkOrders.tsx';
import { api } from './api.ts';
import './styles.css';

function Shell() {
  const account = auth.account();
  return (
    <>
      <div className="topbar">
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <h1>FRCDE</h1>
          <span className="sub">Flood Resilience Common Data Environment</span>
        </div>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Inspection Dashboard
          </NavLink>
          <NavLink to="/work-orders" className={({ isActive }) => (isActive ? 'active' : '')}>
            Inspection Follow-ups
          </NavLink>
          {/* The account they signed in with, not a display name — it is the
              thing they typed and the thing that appears in the audit trail. */}
          <span className="whoami">{account?.username}</span>
          <button className="signout" onClick={() => api.signOut()}>
            Sign out
          </button>
        </nav>
      </div>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/work-orders" element={<WorkOrders />} />
      </Routes>
    </>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(auth.token() !== null);
  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
