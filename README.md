# FB Cookie & Token Tool

App desktop lấy Access Token Facebook từ cookie.

- Chỉ Facebook
- Chạy ngầm local
- Không gửi cookie ra server
- Nút **Cập nhật** trong app (qua GitHub Releases)

## Repo
https://github.com/techzoneadapter-droid/fb-cookie-desktop

## Chạy dev (Windows)
```bash
npm install
npm start
```

## Build file cài đặt
```bash
npm install
npm run build
```
File `.exe` nằm trong `dist/`.

## Phát hành bản cập nhật (cho nút Cập nhật trong app)

1. Tăng `version` trong `package.json` (vd: `1.3.0` → `1.4.0`)
2. Chạy:
```bash
npm run build
```
3. Vào GitHub → **Releases** → **Create a new release**
4. Tag: `v1.4.0` (trùng version)
5. Upload **tất cả file** trong thư mục `dist/` (Setup.exe, latest.yml, blockmap...)
6. Publish release

User bấm **Cập nhật** trong app → tự tải bản mới.

## Giới hạn
- Chỉ Facebook
- Chạy ngầm trên máy local
- Không gửi dữ liệu session ra server ngoài
