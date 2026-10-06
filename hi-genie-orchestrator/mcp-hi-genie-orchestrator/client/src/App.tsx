import { useEffect, useState } from 'react';
import { createBrowserRouter, NavLink, Outlet, RouterProvider } from 'react-router';
import { Activity, GitBranch, Menu, Moon, Network, PanelLeftClose, Server, Sun, UsersRound, X } from 'lucide-react';
import { GraphPage, OverviewPage, ReviewsPage, SessionsPage, SystemPage, WorkstreamsPage } from './pages/ReleasePages';

const navigation = [
  { to: '/', label: 'Overview', icon: Activity, end: true },
  { to: '/workstreams', label: 'Workstreams', icon: GitBranch },
  { to: '/graph', label: 'Graph', icon: Network },
  { to: '/reviews', label: 'Reviews', icon: PanelLeftClose },
  { to: '/sessions', label: 'Sessions', icon: UsersRound },
  { to: '/system', label: 'System', icon: Server },
];

function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('hi-genie-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('hi-genie-theme', theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="mobile-header">
        <button className="icon-button" type="button" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
          <Menu />
        </button>
        <Brand />
        <ThemeButton theme={theme} setTheme={setTheme} />
      </header>
      {mobileOpen && (
        <button
          className="nav-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Primary navigation">
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button sidebar-close"
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
        </div>
        <nav>
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setMobileOpen(false)}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ThemeButton theme={theme} setTheme={setTheme} />
          <span>Fixture-backed R1</span>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        H
      </span>
      <span>
        <strong>Hi Genie</strong>
        <small>Orchestration</small>
      </span>
    </div>
  );
}

function ThemeButton({ theme, setTheme }: { theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="theme-button" type="button" onClick={() => setTheme(next)} aria-label={`Use ${next} theme`}>
      {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
      <span>{theme === 'dark' ? 'Light' : 'Dark'} theme</span>
    </button>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/workstreams', element: <WorkstreamsPage /> },
      { path: '/graph', element: <GraphPage /> },
      { path: '/reviews', element: <ReviewsPage /> },
      { path: '/sessions', element: <SessionsPage /> },
      { path: '/system', element: <SystemPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
