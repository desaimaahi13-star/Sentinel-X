const axios = require('axios');

const base = 'http://localhost:3000';

(async () => {
  try {
    console.log('=== GET / ===');
    const index = await axios.get(base + '/');
    console.log('GET / returned HTML length:', index.data.length);

    console.log('\n=== POST /analyze ===');
    const a = await axios.post(base + '/analyze', { fileName: 'test', hash: 'testhash' });
    console.log('/analyze response:', a.data);

    console.log('\n=== POST /analyze-behavior ===');
    const b = await axios.post(base + '/analyze-behavior', { fileName: 'test', hash: 'testhash' });
    console.log('/analyze-behavior response:', b.data);

    console.log('\n=== GET /behavior-history/testhash ===');
    const h = await axios.get(base + '/behavior-history/testhash');
    console.log('/behavior-history response:', h.data);
  } catch (err) {
    if (err.response) {
      console.error('HTTP error:', err.response.status, err.response.data);
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
})();
