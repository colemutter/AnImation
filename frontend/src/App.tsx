import { useEffect, useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import './App.css'

function App() {
  const [message, setMessage] = useState('Loading…')

  useEffect(() => {
    // Calls the FastAPI backend via the Vite dev proxy (see vite.config.ts).
    fetch('/api/hello')
      .then((res) => res.json())
      .then((data) => setMessage(data.message))
      .catch(() => setMessage('Could not reach the backend. Is it running?'))
  }, [])

  return (
    <>
      <div>
        <a href="https://vite.dev" target="_blank" rel="noreferrer">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank" rel="noreferrer">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>AnImation</h1>
      <div className="card">
        <p>
          <strong>Backend says:</strong> {message}
        </p>
      </div>
    </>
  )
}

export default App
