const axios = require('axios');

(async () => {
  try {
    console.log('=== GET /stats ===');
    const stats = await axios.get('http://localhost:3000/stats');
    console.log('/stats response:', JSON.stringify(stats.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error('HTTP error:', err.response.status, err.response.data);
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
})();
