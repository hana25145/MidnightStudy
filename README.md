# MidnightStudy

기숙사 심야 자습 좌석 신청 웹 앱입니다. Supabase Auth와 PostgreSQL을 사용하며 별도 Node.js 서버가 필요하지 않습니다.

## 기능

- 이름과 비밀번호로 가입·로그인
- `A303`, `B206` 형식의 방 번호에서 층 자동 추출
- 자기 층의 1~7번 좌석 신청
- 신청자 이름 표시
- 학생당 하루 한 좌석, 같은 좌석 중복 신청 차단
- 한국 시간 18:00~23:50 신청 및 취소
- 30초 자동 동기화

## 구성

- `public/`: 정적 웹사이트
- `supabase/migrations/`: 데이터베이스 스키마와 보안 함수
- `public/supabase-config.js`: 브라우저용 Supabase 프로젝트 URL과 publishable key

Publishable key는 브라우저 공개용입니다. 데이터 접근은 RLS와 인증 전용 SQL 함수로 제한됩니다. Secret key나 데이터베이스 비밀번호는 저장소에 넣지 마세요.

## 로컬 실행

```powershell
python -m http.server 3000 -d public
```

브라우저에서 `http://127.0.0.1:3000`을 여세요.

## 정적 호스팅

Cloudflare Pages, Netlify 또는 Vercel에서 저장소를 연결하고 출력 디렉터리를 `public`으로 설정하면 됩니다. 빌드 명령은 필요하지 않습니다.

