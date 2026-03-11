const express = require('express');
const app = express();

app.get('/test', (req, res) => {
    res.json({ message: 'test works' });
});

app.get('/stats', (req, res) => {
    res.json({ stats: 'data' });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Test server running on ${PORT}`);
});
