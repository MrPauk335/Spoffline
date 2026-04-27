import urllib.request, urllib.parse, json

query = 'recording:Радио Огонь'
url = 'https://musicbrainz.org/ws/2/recording?fmt=json&limit=5&query=' + urllib.parse.quote(query)
req = urllib.request.Request(url, headers={'User-Agent': 'Spoffline/1.0'})
try:
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read())
        print('Hits:', len(data.get('recordings', [])))
        if data.get('recordings'):
            r = data['recordings'][0]
            print('Score:', r.get('score'))
            print('Title:', r.get('title'))
            print('Artist:', r.get('artist-credit', [{}])[0].get('name'))
except Exception as e:
    print('Error:', e)
