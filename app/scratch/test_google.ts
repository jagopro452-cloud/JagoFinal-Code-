import axios from 'axios';

async function testGoogle() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is required');
  const query = 'bengaluru';
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${query}&key=${apiKey}&components=country:in`;

  try {
    const res = await axios.get(url);
    console.log(res.data.status);
    console.log(res.data.predictions.length);
  } catch(e) {
    console.error(e.response?.data || e.message);
  }
}

testGoogle();
