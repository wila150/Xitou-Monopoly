8 個固定地點關卡的真實現場照片，檔名對應 `src/config/checkpoints.json` 裡各關卡的 `mapFiles` 陣列（一關可以有多張）：

```
A2.jpg  B3.jpg  C4.jpg  A5.jpg  A3.jpg  D6.jpg
B4-1.jpg  B4-2.jpg          （百步穿揚，星光教室，2 張）
B6-1.jpg  B6-2.jpg  B6-3.jpg（勝利之堡，石板廣場，3 張）
E3.jpg    （目前仍是溪頭步道導覽圖裁切出的示意地圖，還沒有現場實拍照）
```

D5、C5、E2 是地點不限的彈性關卡，不需要圖片（`mapFiles` 是空陣列）。

要換圖片或調整某關張數，直接把新照片放進這個資料夾、修改 `src/config/checkpoints.json` 對應關卡的 `mapFiles` 陣列即可（或用 `npm run checkpoints:export` / `checkpoints:import` 透過 CSV 編輯，`mapFiles` 欄位用「;」分隔多張檔名）。
