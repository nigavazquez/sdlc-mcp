export function Login() {
  return (
    <div className="login-box card">
      <h1>SDLC Admin</h1>
      <p className="muted">Accedé con tu cuenta corporativa de Google.</p>
      <a className="btn" href="/oauth/authorize?mode=admin" style={{ display: 'block', textAlign: 'center' }}>
        Sign in with Google
      </a>
    </div>
  );
}
