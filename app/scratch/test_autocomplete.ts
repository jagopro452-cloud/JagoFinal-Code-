import axios from 'axios';

async function testAutocomplete() {
  try {
    const res = await axios.get('http://localhost:5000/api/app/places/autocomplete?query=man', {
      headers: {
        'Accept': 'application/json'
      }
    });
    console.log('Status:', res.status);
    console.log('Data:', JSON.stringify(res.data, null, 2));
  } catch (e: any) {
    console.error('Error:', e.response?.status, e.response?.data || e.message);
  }
}

testAutocomplete();
