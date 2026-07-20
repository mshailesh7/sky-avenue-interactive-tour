# Tour media (not in git)

This folder holds the large 360° panorama assets (~3GB).

## Local
Keep your exported `media/` files here:
`360-website/public/tour/media/`

## EC2 deploy
After cloning the repo, sync media from your machine:

```bash
rsync -avz --progress ./public/tour/media/ ubuntu@YOUR_EC2_IP:/var/www/sky-avenue-360/public/tour/media/
```

Or upload a zip and extract into this path on the server.
