/* 화면 언어 (한국어 / English). 게임 데이터·시뮬레이션 문자열은 늘 한국어이고, 그릴 때 lang_tr 로 바꾼다.
 * 사전은 c/data/lang_en.csv (ko,en). ko 의 {0}…{9} 는 아무 글이나 받는 자리이고, 받은 글도 다시 번역한다. */
#pragma once
#include <stdbool.h>

typedef enum { LANG_KO, LANG_EN, LANG__COUNT } Lang;

void lang_set(Lang lang);
Lang lang_get(void);
/** 지금 언어로 바꾼 문자열. 바꿀 것이 없으면 s 그대로. 돌려준 포인터는 다음 수천 번의 호출 동안 유효하다 */
const char *lang_tr(const char *s);
/** 한국어가 아니어도 사전에서 그대로 찾는다 (시험용): 없으면 NULL */
const char *lang_en_exact(const char *ko);
