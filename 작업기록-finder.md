# Coin Finder 작업 기록 (2026-10-15)

> 원문 대화 다운로드는 채팅 앱의 세션 메뉴(⋯) → 내보내기/다운로드로 하세요.
> 이 파일은 작업 내용 정리본입니다. 원본 파일: C:\Users\admin\Desktop\my apple 2\finder\index.html

## 1. REA 설치·연결 (완료, 재시작 대기)
- portable Node v24.20.0 + npm 11.19.0 (`%LOCALAPPDATA%\nodejs-portable`)
- `npx rea-agents@latest setup --client opencode` 적용됨
- opencode.json `mcp.rea` aligned / 스킬 v42·207개 aligned
- doctor `--client opencode` healthy / `--skill` healthy
- 사용자 PATH 등록 완료 → **앱 재시작 1회 남음** (MCP rea 빨간불 → 초록불 확인 필요)

## 2. 깃허브·Vercel 정리 (완료)
- 삭제: new-rea, rea(fork), Rea1, Vercel rea·rea-c736
- 원인: REA 리포를 Vercel에 올려 turbo 빌드 실패. REA는 배포 대상 아님

## 3. finder 개조 내역 (index.html, 검증됨)
1. 국내상장 열: 업비트·빗썸 티커 일치 표시, 24h 캐시 (ensureKrListings)
2. 섹터 12→14개: privacy(보안·프라이버시), payments(결제·금융) 추가
3. 파생 3지표: 펀딩비·미체결약정·롱숏비율 (바이낸스 공개 API, 키 불필요)
4. 전종목 스냅샷 Top30 + 고래벽 (±5%·1%·사다리 의심)
5. 속도: 기본 12→4페이지, 대기 중 전체 렌더 제거 (12초 간격 유지)
6. 추세 표 열 순서 변경: 순위·자산·가격·시총·추세전환도·추천순위·유동성·24h폭증·20일선크로스·판정·갱신시각
7. 링크 순서: CoinMarketCap 원문 → CoinGecko → DEX → CMC 찾기 (숫자ID 가짜 직링크 삭제)
8. 브랜드: GEMS/RESEARCH(초록) → COIN/FINDER(파랑), 심층 확인 기본 8→16개
- 전부 node --check 통과, 외부 API 16개 실측 200

## 4. README 반영
- Upbit·Bithumb·Binance 공개 API 행 추가, 14개 섹터, 기본 4페이지, 파생·고래벽 설명
- 제목 Gems Research → Coin Finder (1줄만, 나머지는 원본 유지)

## 5. 보류 (사유)
- ETF 표: 무료 통합 API 없음
- 지갑 이탈 추적: 유료(Nansen/Arkham) → 호가벽·거래량으로 대체
- 매수 신호 문구 일체 없음 (연구 우선순위 + 주의요함 체계)

## 6. 미결 (다음 할 일)
- [ ] 앱 재시작 후 MCP rea 초록불 확인
- [ ] index.html + README.md를 coin-finder 리포에 업로드
- [ ] **Production 배포 3연속 실패 중** → 실패 건 Build Logs 첫 에러 10줄 필요
- [ ] package.json engines 24.x / vercel.json functions 블록 삭제 반영 확인
