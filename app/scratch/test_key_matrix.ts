import axios from 'axios';

async function testGoogle(headers: any, desc: string) {
  const apiKey = 'AIzaSyDj3UNBM04zhLbnKrYQa_8WQ9anNXhOcY4';
  const query = 'bengaluru';
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${query}&key=${apiKey}&components=country:in`;

  try {
    const res = await axios.get(url, { headers });
    console.log(`[${desc}] SUCCESS:`, res.data.status);
  } catch(e: any) {
    console.log(`[${desc}] FAILED:`, e.response?.data?.status || e.message);
  }
}

async function run() {
  await testGoogle({ 'Referer': 'https://jagopro.org' }, "Referer: jagopro");
  await testGoogle({ 'Referer': 'http://localhost:5000' }, "Referer: localhost");
  await testGoogle({}, "No Referer");
  await testGoogle({ 'X-Android-Package': 'com.jagopro.customer', 'X-Android-Cert': '0000' }, "Android Headers");
  await testGoogle({ 'X-Ios-Bundle-Identifier': 'com.jagopro.customer' }, "iOS Headers");
}

run();
