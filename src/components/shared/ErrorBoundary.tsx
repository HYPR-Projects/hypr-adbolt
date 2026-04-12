import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '60vh', padding: '40px 20px',
        textAlign: 'center', fontFamily: 'var(--font)',
      }}>
        <div style={{ fontSize: '2.4rem', marginBottom: 16 }}>⚠️</div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>
          {this.props.fallbackMessage || 'Algo deu errado'}
        </h2>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-sec)', marginBottom: 20, maxWidth: 400 }}>
          Um erro inesperado ocorreu. Tente recarregar ou voltar à tela inicial.
        </p>
        {this.state.error && (
          <pre style={{
            fontSize: '0.7rem', color: 'var(--error)', background: 'var(--error-dim)',
            padding: '8px 14px', borderRadius: 'var(--r-xs)', marginBottom: 16,
            maxWidth: '90%', overflow: 'auto', whiteSpace: 'pre-wrap',
          }}>
            {this.state.error.message}
          </pre>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={this.handleReload}
            style={{
              padding: '8px 20px', fontSize: '0.82rem', fontWeight: 500,
              background: 'var(--accent)', color: 'var(--text-on-accent)',
              border: 'none', borderRadius: 'var(--r-xs)', cursor: 'pointer',
              fontFamily: 'var(--font)',
            }}
          >
            Tentar novamente
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px', fontSize: '0.82rem', fontWeight: 500,
              background: 'transparent', color: 'var(--text-sec)',
              border: '1px solid var(--border)', borderRadius: 'var(--r-xs)',
              cursor: 'pointer', fontFamily: 'var(--font)',
            }}
          >
            Recarregar página
          </button>
        </div>
      </div>
    );
  }
}
