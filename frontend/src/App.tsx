import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { ProtectedRoute } from './components/ProtectedRoute';
import { NotificationPanel } from './components/NotificationPanel';
import { WebSocketProvider } from './context/WebSocketContext';
import { DashboardPage } from './pages/DashboardPage';
import { HabitDetailPage } from './pages/HabitDetailPage';
import { LoginPage } from './pages/LoginPage';

/**
 * Route layout (SPEC §9):
 *   /login            → LoginPage
 *   /                 → DashboardPage (protected)
 *   /habits/:id       → HabitDetailPage (protected)
 *
 * The authenticated subtree is wrapped in an `AuthedLayout` that mounts
 * `WebSocketProvider` + `NotificationPanel` ONCE for the whole signed-in area,
 * so navigating `/` ↔ `/habits/:id` keeps the socket open and in-flight
 * milestone toasts alive (mounting the provider per-route instead would
 * unmount/remount it on every navigation, dropping toasts and churning the
 * connection). `ProtectedRoute` wraps the layout; the provider itself only
 * connects when a user is present (it keys `enabled` on the authed user).
 */
function AuthedLayout() {
  return (
    <WebSocketProvider>
      <NotificationPanel />
      <Outlet />
    </WebSocketProvider>
  );
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  // If a signed-in user lands on /login, send them straight to the dashboard.
  useEffect(() => {
    if (isAuthenticated && location.pathname === '/login') {
      window.location.replace('/');
    }
  }, [isAuthenticated, location.pathname]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AuthedLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/habits/:id" element={<HabitDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return <AppRoutes />;
}
