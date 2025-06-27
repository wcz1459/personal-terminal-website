import MatrixRain from './MatrixRain';
import Terminal from './Terminal';

function App() {
  return (
    <div className="app">
      <MatrixRain />
      <div className="overlay">
        <Terminal />
      </div>
    </div>
  );
}

export default App;