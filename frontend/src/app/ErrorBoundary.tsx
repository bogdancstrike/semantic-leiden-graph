import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'
import { isChunkLoadError } from '@/lib/lazyPage'

interface State {
  error: Error | null
}

/**
 * Every page renders inside the boundary and the boundary inside the shell: a
 * fault in one page must not take the navigation with it. Reset on the route.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack)
  }

  render() {
    if (this.state.error && isChunkLoadError(this.state.error)) {
      // A deploy replaced the code this tab was started with, and the automatic reload
      // already happened (or storage is off): "Try again" would re-run the same failed
      // import, so the only useful action is loading the new version.
      return (
        <Result
          status="info"
          title="A new version of the app is available"
          subTitle="This tab still runs the previous version, whose files were replaced. Reload to continue; nothing you saved is lost."
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      )
    }
    if (this.state.error) {
      return (
        <Result
          status="warning"
          title="This view hit an unexpected error"
          subTitle={this.state.error.message}
          extra={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}
        />
      )
    }
    return this.props.children
  }
}
