"""
Kiro 企业登录 (IdC/IAM Identity Center)
使用 Device Authorization Flow 实现
支持批量账号处理、MFA 自动注册、授权页面自动确认
"""

import requests
import time
import hashlib
import json
import argparse
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

# 配置
BASE_DIR = Path(__file__).parent
ACCOUNT_FILE = BASE_DIR / "account.txt"
MFA_FILE = BASE_DIR / "mfa_secrets.json"
TOKEN_FILE = BASE_DIR / "token_result.json"
BATCH_TOKEN_FILE = BASE_DIR / "batch_tokens.json"
DEFAULT_NEW_PASSWORD = "4561230wW?"


def load_accounts(file_path=None):
    """从文件加载所有账号信息（支持多行批量）"""
    file_path = file_path or ACCOUNT_FILE
    accounts = []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("----")
                if len(parts) < 1:
                    print(f"[警告] 第 {line_num} 行格式错误，跳过")
                    continue
                accounts.append({
                    "start_url": parts[0] if len(parts) > 0 else "",
                    "region": parts[1] if len(parts) > 1 else "us-east-1",
                    "email": parts[2] if len(parts) > 2 else "",
                    "password": parts[3] if len(parts) > 3 else "",
                    "line_num": line_num,
                    "original_line": line,
                })
    except FileNotFoundError:
        print(f"账号文件不存在: {file_path}")
    except Exception as e:
        print(f"读取账号文件失败: {e}")
    return accounts


def load_account(file_path=None):
    """从文件加载第一个账号信息（兼容旧接口）"""
    accounts = load_accounts(file_path)
    return accounts[0] if accounts else None


def delete_account_line(original_line, file_path=None):
    """从账号文件中删除指定行"""
    file_path = file_path or ACCOUNT_FILE
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        new_lines = []
        deleted = False
        for line in lines:
            if line.strip() == original_line and not deleted:
                deleted = True
                print(f"[删除] 已从账号文件删除: {original_line[:50]}...")
                continue
            new_lines.append(line)

        if deleted:
            with open(file_path, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
            return True
        return False
    except Exception as e:
        print(f"[删除] 删除账号行失败: {e}")
        return False


def load_mfa_secrets():
    """加载已保存的 MFA 秘钥"""
    try:
        if MFA_FILE.exists():
            with open(MFA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[MFA] 加载秘钥文件失败: {e}")
    return {}


def get_saved_mfa_secret(email):
    """获取已保存的 MFA 秘钥"""
    secrets = load_mfa_secrets()
    if email in secrets:
        return secrets[email].get("secret")
    return None


def compute_client_id_hash(start_url):
    """计算 clientIdHash"""
    return hashlib.sha256(start_url.encode()).hexdigest()


def auto_login_with_selenium(url, email, password, max_retries=3, headless=False):
    """使用 Selenium 自动登录，支持重试"""
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.chrome.options import Options
        from selenium.common.exceptions import TimeoutException, NoSuchElementException

        print("\n[Selenium] 启动浏览器...")

        options = Options()
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])
        options.add_experimental_option("useAutomationExtension", False)

        if headless:
            options.add_argument("--headless=new")
            options.add_argument("--window-size=1920,1080")
            options.add_argument("--disable-gpu")
            print("[Selenium] 无头模式")

        driver = webdriver.Chrome(options=options)
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        driver.get(url)

        wait = WebDriverWait(driver, 30)
        short_wait = WebDriverWait(driver, 5)

        for attempt in range(max_retries):
            try:
                # 等待用户名输入框并输入
                print("[Selenium] 等待用户名输入框...")
                username_input = wait.until(EC.presence_of_element_located(
                    (By.CSS_SELECTOR, "input[type='text'], input[type='email'], input[name='username'], input[name='email']")
                ))
                username_input.clear()
                time.sleep(0.3)
                username_input.send_keys(email)
                print(f"[Selenium] 已输入用户名: {email}")

                # 点击下一步按钮
                time.sleep(1)
                next_btn = wait.until(EC.element_to_be_clickable(
                    (By.CSS_SELECTOR, "button[type='submit'], input[type='submit']")
                ))
                next_btn.click()
                print("[Selenium] 点击下一步")

                # 等待密码输入框并输入
                time.sleep(2)
                print("[Selenium] 等待密码输入框...")
                password_input = wait.until(EC.presence_of_element_located(
                    (By.CSS_SELECTOR, "input[type='password']")
                ))
                password_input.clear()
                time.sleep(0.3)
                password_input.send_keys(password)
                print("[Selenium] 已输入密码")

                # 点击登录按钮
                time.sleep(1)
                login_btn = wait.until(EC.element_to_be_clickable(
                    (By.CSS_SELECTOR, "button[type='submit'], input[type='submit']")
                ))
                login_btn.click()
                print("[Selenium] 点击登录")

                # 等待页面加载
                time.sleep(3)

                # 检查是否有错误提示
                error_elements = driver.find_elements(By.CSS_SELECTOR, ".error, .alert-error, [class*='error'], [class*='Error']")
                if error_elements:
                    error_text = error_elements[0].text
                    if error_text:
                        # 检查是否是凭证验证失败的错误
                        credential_errors = [
                            "无法验证您的登录凭证", "无法验证", "验证您的登录凭证",
                            "couldn't verify", "can't verify", "unable to verify",
                            "invalid credentials", "incorrect", "invalid"
                        ]
                        is_credential_error = any(err in error_text.lower() or err in error_text for err in credential_errors)

                        if is_credential_error:
                            print(f"[Selenium] 凭证验证失败: {error_text}")
                            return driver, "CREDENTIAL_ERROR"

                        if "incorrect" in error_text.lower() or "invalid" in error_text.lower():
                            print(f"[Selenium] 登录错误: {error_text}")
                            if attempt < max_retries - 1:
                                print(f"[Selenium] 重试 ({attempt + 2}/{max_retries})...")
                                driver.refresh()
                                time.sleep(2)
                                continue
                            else:
                                return driver, None

                # 检查是否需要 MFA 验证（已有 MFA）
                mfa_secret = handle_mfa_verification(driver, wait, email)

                # 检查是否是 MFA 注册页面
                if not mfa_secret:
                    mfa_secret = handle_mfa_registration(driver, wait, email)

                # 处理新密码设置页面
                handle_new_password_page(driver, wait)

                # 处理授权确认页面
                handle_authorization_page(driver, wait)

                print("[Selenium] 登录流程完成")
                return driver, mfa_secret

            except TimeoutException as e:
                print(f"[Selenium] 超时: {e}")
                if attempt < max_retries - 1:
                    print(f"[Selenium] 重试 ({attempt + 2}/{max_retries})...")
                    driver.refresh()
                    time.sleep(2)
                else:
                    return driver, None
            except Exception as e:
                print(f"[Selenium] 错误: {e}")
                if attempt < max_retries - 1:
                    print(f"[Selenium] 重试 ({attempt + 2}/{max_retries})...")
                    time.sleep(2)
                else:
                    return driver, None

        return driver, None

    except ImportError:
        print("需要安装 selenium: pip install selenium")
        return None, None
    except Exception as e:
        print(f"[Selenium] 启动错误: {e}")
        return None, None


def handle_mfa_verification(driver, wait, email):
    """处理已有 MFA 的验证流程"""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC

    try:
        # 检查是否有 MFA 验证码输入框
        mfa_inputs = driver.find_elements(By.CSS_SELECTOR,
            "input[name='code'], input[name='totp'], input[placeholder*='验证码'], input[placeholder*='code'], input[autocomplete='one-time-code']"
        )

        if not mfa_inputs:
            # 检查页面是否包含 MFA 相关文字
            page_text = driver.page_source.lower()
            if "authenticator" not in page_text and "验证码" not in page_text and "mfa" not in page_text:
                return None

            # 尝试等待 MFA 输入框出现
            try:
                mfa_input = WebDriverWait(driver, 3).until(EC.presence_of_element_located(
                    (By.CSS_SELECTOR, "input[name='code'], input[name='totp'], input[type='text'][maxlength='6']")
                ))
            except:
                return None
        else:
            mfa_input = mfa_inputs[0]

        print("[MFA] 检测到 MFA 验证页面")

        # 获取已保存的 MFA 秘钥
        mfa_secret = get_saved_mfa_secret(email)
        if not mfa_secret:
            print("[MFA] 未找到已保存的 MFA 秘钥，请手动输入验证码")
            return None

        print(f"[MFA] 使用已保存的秘钥")

        # 获取 TOTP 验证码
        totp_code = get_totp_code(mfa_secret)
        if not totp_code:
            print("[MFA] 无法生成验证码")
            return mfa_secret

        print(f"[MFA] 生成验证码: {totp_code}")

        # 输入验证码
        mfa_input.clear()
        time.sleep(0.3)
        mfa_input.send_keys(totp_code)
        print("[MFA] 已输入验证码")

        # 点击提交按钮
        time.sleep(1)
        try:
            submit_btn = driver.find_element(By.CSS_SELECTOR, "button[type='submit'], input[type='submit']")
            submit_btn.click()
            print("[MFA] 点击提交")
        except:
            pass

        time.sleep(2)
        return mfa_secret

    except Exception as e:
        print(f"[MFA] 验证处理出错: {e}")
        return None


def handle_mfa_registration(driver, wait, email, max_wait=15):
    """处理 MFA 注册流程"""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    mfa_secret = None

    try:
        # 等待页面加载完成
        print("[MFA] 等待页面加载...")
        time.sleep(3)

        # 多次尝试检测 MFA 注册页面
        mfa_keywords = [
            "身份验证器应用程序", "Authenticator app", "authenticator",
            "MFA", "多重身份验证", "Multi-factor",
            "Register MFA", "注册 MFA", "设置 MFA", "Set up MFA"
        ]

        mfa_detected = False
        for attempt in range(max_wait // 3):
            page_source = driver.page_source
            for keyword in mfa_keywords:
                if keyword.lower() in page_source.lower():
                    mfa_detected = True
                    print(f"[MFA] 检测到 MFA 页面关键词: {keyword}")
                    break

            if mfa_detected:
                break

            # 也尝试查找元素
            mfa_elements = driver.find_elements(By.XPATH,
                "//*[contains(text(),'身份验证器应用程序') or contains(text(),'Authenticator app') or contains(text(),'authenticator')]"
            )
            if mfa_elements:
                mfa_detected = True
                print("[MFA] 检测到 MFA 注册元素")
                break

            print(f"[MFA] 等待 MFA 页面... ({attempt + 1}/{max_wait // 3})")
            time.sleep(3)

        if not mfa_detected:
            print("[MFA] 未检测到 MFA 注册页面")
            return None

        print("[MFA] 检测到 MFA 注册页面")
        time.sleep(2)

        # 尝试点击身份验证器应用程序选项
        try:
            radio_selectors = [
                "//input[@type='radio']",
                "//div[contains(@class,'radio')]//input",
                "//label[contains(text(),'身份验证器') or contains(text(),'Authenticator')]//input",
                "//label[contains(text(),'身份验证器') or contains(text(),'Authenticator')]",
                "//*[contains(text(),'身份验证器应用程序') or contains(text(),'Authenticator app')]"
            ]

            clicked = False
            for selector in radio_selectors:
                try:
                    elements = driver.find_elements(By.XPATH, selector)
                    for elem in elements:
                        if elem.is_displayed():
                            elem.click()
                            clicked = True
                            print("[MFA] 选择身份验证器应用程序")
                            break
                    if clicked:
                        break
                except:
                    continue

            if not clicked:
                print("[MFA] 未找到单选按钮，可能已默认选中")

        except Exception as e:
            print(f"[MFA] 选择选项时出错: {e}")

        # 点击下一步
        time.sleep(2)
        try:
            next_selectors = [
                "//button[contains(text(),'下一步') or contains(text(),'Next')]",
                "//button[@type='submit']",
                "//input[@type='submit']",
                "//button[contains(@class,'primary')]"
            ]

            for selector in next_selectors:
                try:
                    next_btn = driver.find_element(By.XPATH, selector)
                    if next_btn.is_displayed() and next_btn.is_enabled():
                        next_btn.click()
                        print("[MFA] 点击下一步")
                        break
                except:
                    continue
        except Exception as e:
            print(f"[MFA] 点击下一步出错: {e}")

        # 等待页面加载
        print("[MFA] 等待秘钥页面加载...")
        time.sleep(5)

        # 点击"显示秘钥"
        try:
            show_key_selectors = [
                "//*[contains(text(),'显示秘钥') or contains(text(),'Show secret') or contains(text(),'显示密钥')]",
                "//*[contains(text(),'show') and contains(text(),'key')]",
                "//a[contains(@class,'show')]",
                "//button[contains(text(),'显示') or contains(text(),'Show')]"
            ]

            for selector in show_key_selectors:
                try:
                    show_btn = WebDriverWait(driver, 5).until(
                        EC.element_to_be_clickable((By.XPATH, selector))
                    )
                    show_btn.click()
                    print("[MFA] 点击显示秘钥")
                    time.sleep(2)
                    break
                except:
                    continue
        except:
            print("[MFA] 未找到显示秘钥按钮，尝试直接获取")

        # 获取秘钥
        time.sleep(2)
        secret_selectors = [
            "//code",
            "//span[contains(@class,'secret')]",
            "//div[contains(@class,'secret')]",
            "//pre",
            "//input[@readonly]",
            "//*[@data-testid='secret-key']"
        ]

        for selector in secret_selectors:
            try:
                elements = driver.find_elements(By.XPATH, selector)
                for elem in elements:
                    text = elem.text.strip() or elem.get_attribute("value") or ""
                    if text and len(text) >= 16 and len(text) <= 64:
                        clean_text = text.replace(" ", "").replace("-", "")
                        if re.match(r'^[A-Z2-7]+$', clean_text):
                            mfa_secret = clean_text
                            print(f"[MFA] 获取到秘钥: {mfa_secret}")
                            break
                if mfa_secret:
                    break
            except:
                continue

        # 从页面源码中提取
        if not mfa_secret:
            page_source = driver.page_source
            patterns = [
                r'[A-Z2-7]{32}',
                r'[A-Z2-7]{16}',
            ]
            for pattern in patterns:
                match = re.search(pattern, page_source)
                if match:
                    mfa_secret = match.group(0)
                    print(f"[MFA] 从页面提取秘钥: {mfa_secret}")
                    break

        if not mfa_secret:
            print("[MFA] 无法获取秘钥，请手动操作")
            return None

        # 保存秘钥到文件
        save_mfa_secret(email, mfa_secret)

        # 获取 TOTP 验证码
        totp_code = get_totp_code(mfa_secret)
        if not totp_code:
            print("[MFA] 无法获取验证码")
            return mfa_secret

        print(f"[MFA] 获取到验证码: {totp_code}")

        # 输入验证码
        time.sleep(1)
        code_input = None
        code_selectors = [
            "input[type='text'][maxlength='6']",
            "input[name='code']",
            "input[name='totp']",
            "input[placeholder*='验证']",
            "input[placeholder*='code']",
            "input[type='text']"
        ]

        for selector in code_selectors:
            try:
                inputs = driver.find_elements(By.CSS_SELECTOR, selector)
                for inp in inputs:
                    if inp.is_displayed():
                        code_input = inp
                        break
                if code_input:
                    break
            except:
                continue

        if code_input:
            code_input.clear()
            time.sleep(0.3)
            code_input.send_keys(totp_code)
            print("[MFA] 已输入验证码")
        else:
            print("[MFA] 未找到验证码输入框")

        # 点击提交按钮（分配MFA）
        time.sleep(2)
        submit_selectors = [
            "//button[contains(text(),'分配 MFA') or contains(text(),'Assign MFA')]",
            "//button[contains(text(),'分配MFA')]",
            "//button[contains(text(),'分配') or contains(text(),'Assign')]",
            "//button[contains(text(),'提交') or contains(text(),'Submit')]",
            "//button[contains(text(),'确认') or contains(text(),'Confirm')]",
            "//button[contains(text(),'验证') or contains(text(),'Verify')]",
            "//button[@type='submit']"
        ]

        for selector in submit_selectors:
            try:
                submit_btn = driver.find_element(By.XPATH, selector)
                if submit_btn.is_displayed() and submit_btn.is_enabled():
                    submit_btn.click()
                    print("[MFA] 点击分配MFA")
                    break
            except:
                continue

        # 等待并点击"完成"按钮
        time.sleep(3)
        handle_done_button(driver)

        return mfa_secret

    except Exception as e:
        print(f"[MFA] 处理 MFA 注册时出错: {e}")
        import traceback
        traceback.print_exc()
        return mfa_secret


def handle_done_button(driver):
    """处理完成按钮"""
    from selenium.webdriver.common.by import By

    try:
        done_selectors = [
            "//button[contains(text(),'完成') or contains(text(),'Done')]",
            "//button[contains(text(),'完成设置') or contains(text(),'Finish')]",
            "//button[contains(text(),'关闭') or contains(text(),'Close')]",
            "//a[contains(text(),'完成') or contains(text(),'Done')]",
            "//button[@type='submit']"
        ]

        for selector in done_selectors:
            try:
                btn = driver.find_element(By.XPATH, selector)
                if btn.is_displayed() and btn.is_enabled():
                    btn.click()
                    print("[MFA] 点击完成")
                    time.sleep(3)

                    # 完成后检查是否有密码设置页面
                    handle_password_after_mfa(driver)
                    return
            except:
                continue

    except Exception as e:
        print(f"[MFA] 处理完成按钮出错: {e}")


def handle_password_after_mfa(driver):
    """MFA完成后处理密码设置页面"""
    from selenium.webdriver.common.by import By

    try:
        # 检查是否有密码输入框
        password_inputs = driver.find_elements(By.CSS_SELECTOR, "input[type='password']")

        if len(password_inputs) >= 2:
            print("[密码] 检测到密码设置页面")

            new_password = DEFAULT_NEW_PASSWORD

            # 输入新密码
            password_inputs[0].clear()
            time.sleep(0.3)
            password_inputs[0].send_keys(new_password)
            print("[密码] 已输入新密码")

            # 输入确认密码
            time.sleep(0.5)
            password_inputs[1].clear()
            time.sleep(0.3)
            password_inputs[1].send_keys(new_password)
            print("[密码] 已输入确认密码")

            # 点击"设置新密码"按钮
            time.sleep(1)
            submit_selectors = [
                "//button[contains(text(),'设置新密码') or contains(text(),'Set new password')]",
                "//button[contains(text(),'设置密码') or contains(text(),'Set password')]",
                "//button[contains(text(),'提交') or contains(text(),'Submit')]",
                "//button[contains(text(),'保存') or contains(text(),'Save')]",
                "//button[contains(text(),'确认') or contains(text(),'Confirm')]",
                "//button[contains(text(),'继续') or contains(text(),'Continue')]",
                "//button[@type='submit']"
            ]

            for selector in submit_selectors:
                try:
                    btn = driver.find_element(By.XPATH, selector)
                    if btn.is_displayed() and btn.is_enabled():
                        btn.click()
                        print("[密码] 点击设置新密码")
                        time.sleep(3)
                        print(f"[密码] 新密码已设置: {new_password}")

                        # 密码设置后处理"确认并继续"页面
                        handle_confirm_and_continue(driver)
                        break
                except:
                    continue

    except Exception as e:
        print(f"[密码] 处理密码页面出错: {e}")


def handle_confirm_and_continue(driver):
    """处理'确认并继续'授权页面（已请求授权）"""
    from selenium.webdriver.common.by import By

    try:
        # 等待页面加载
        for attempt in range(5):
            time.sleep(3)

            # 检查是否有"确认并继续"按钮
            page_source = driver.page_source
            if "确认并继续" in page_source or "Confirm and continue" in page_source or "已请求授权" in page_source:
                print("[授权] 检测到'确认并继续'页面")

                confirm_selectors = [
                    "//button[contains(text(),'确认并继续')]",
                    "//button[contains(text(),'Confirm and continue')]",
                    "//span[contains(text(),'确认并继续')]/parent::button",
                    "//button[contains(@class,'awsui-button--primary')]",
                    "//button[contains(@class,'primary')]",
                    "//button[@type='submit']"
                ]

                for selector in confirm_selectors:
                    try:
                        btns = driver.find_elements(By.XPATH, selector)
                        for btn in btns:
                            if btn.is_displayed() and btn.is_enabled():
                                driver.execute_script("arguments[0].scrollIntoView(true);", btn)
                                time.sleep(0.5)
                                btn.click()
                                print("[授权] 点击'确认并继续'")
                                time.sleep(3)

                                # 继续处理下一个授权页面（允许访问）
                                handle_allow_access(driver)
                                return
                    except:
                        continue

            print(f"[授权] 等待页面加载... ({attempt + 1}/5)")

    except Exception as e:
        print(f"[授权] 处理确认页面出错: {e}")


def handle_allow_access(driver):
    """处理'允许访问'页面"""
    from selenium.webdriver.common.by import By

    try:
        # 等待页面加载
        for attempt in range(5):
            time.sleep(3)

            page_source = driver.page_source
            if "允许" in page_source or "Allow" in page_source or "允许访问" in page_source:
                print("[授权] 检测到'允许访问'页面")

                allow_selectors = [
                    "//button[contains(text(),'允许访问')]",
                    "//button[contains(text(),'Allow access')]",
                    "//button[contains(text(),'允许')]",
                    "//button[contains(text(),'Allow')]",
                    "//span[contains(text(),'允许')]/parent::button",
                    "//button[contains(@class,'awsui-button--primary')]",
                    "//button[contains(@class,'primary')]",
                    "//button[@type='submit']"
                ]

                for selector in allow_selectors:
                    try:
                        btns = driver.find_elements(By.XPATH, selector)
                        for btn in btns:
                            if btn.is_displayed() and btn.is_enabled():
                                driver.execute_script("arguments[0].scrollIntoView(true);", btn)
                                time.sleep(0.5)
                                btn.click()
                                print("[授权] 点击'允许访问'")
                                time.sleep(2)
                                return
                    except:
                        continue

            print(f"[授权] 等待允许页面... ({attempt + 1}/5)")

    except Exception as e:
        print(f"[授权] 处理允许页面出错: {e}")


def handle_new_password_page(driver, wait, new_password=None):
    """处理新密码设置页面"""
    from selenium.webdriver.common.by import By

    new_password = new_password or DEFAULT_NEW_PASSWORD

    try:
        time.sleep(2)

        # 检查是否有新密码设置页面
        page_source = driver.page_source.lower()
        password_keywords = [
            "new password", "新密码", "set password", "设置密码",
            "create password", "创建密码", "change password", "更改密码",
            "confirm password", "确认密码", "reset password", "重置密码"
        ]

        has_password_page = any(keyword in page_source for keyword in password_keywords)

        # 也检查是否有多个密码输入框
        password_inputs = driver.find_elements(By.CSS_SELECTOR, "input[type='password']")

        if not has_password_page and len(password_inputs) < 2:
            return

        print("[密码] 检测到新密码设置页面")

        # 查找密码输入框
        if len(password_inputs) >= 2:
            # 通常第一个是新密码，第二个是确认密码
            new_pwd_input = password_inputs[0]
            confirm_pwd_input = password_inputs[1]

            # 输入新密码
            new_pwd_input.clear()
            time.sleep(0.3)
            new_pwd_input.send_keys(new_password)
            print(f"[密码] 已输入新密码")

            # 输入确认密码
            time.sleep(0.5)
            confirm_pwd_input.clear()
            time.sleep(0.3)
            confirm_pwd_input.send_keys(new_password)
            print(f"[密码] 已输入确认密码")

        elif len(password_inputs) == 1:
            # 只有一个密码框
            password_inputs[0].clear()
            time.sleep(0.3)
            password_inputs[0].send_keys(new_password)
            print(f"[密码] 已输入密码")

        # 点击提交按钮
        time.sleep(1)
        submit_selectors = [
            "//button[contains(text(),'提交') or contains(text(),'Submit')]",
            "//button[contains(text(),'保存') or contains(text(),'Save')]",
            "//button[contains(text(),'确认') or contains(text(),'Confirm')]",
            "//button[contains(text(),'设置') or contains(text(),'Set')]",
            "//button[contains(text(),'更新') or contains(text(),'Update')]",
            "//button[contains(text(),'继续') or contains(text(),'Continue')]",
            "//button[@type='submit']",
            "//input[@type='submit']"
        ]

        for selector in submit_selectors:
            try:
                btn = driver.find_element(By.XPATH, selector)
                if btn.is_displayed() and btn.is_enabled():
                    btn.click()
                    print("[密码] 点击提交")
                    break
            except:
                continue

        time.sleep(3)
        print(f"[密码] 新密码已设置: {new_password}")

        # 处理"确认并继续"页面
        handle_confirm_continue(driver)

    except Exception as e:
        print(f"[密码] 处理新密码页面出错: {e}")


def handle_confirm_continue(driver):
    """处理确认并继续页面"""
    from selenium.webdriver.common.by import By

    try:
        time.sleep(2)

        # 查找并点击"确认并继续"按钮
        confirm_selectors = [
            "//button[contains(text(),'确认并继续') or contains(text(),'Confirm and continue')]",
            "//button[contains(text(),'继续') or contains(text(),'Continue')]",
            "//button[contains(text(),'下一步') or contains(text(),'Next')]",
            "//button[contains(text(),'确认') or contains(text(),'Confirm')]",
            "//a[contains(text(),'确认并继续') or contains(text(),'Confirm and continue')]",
            "//a[contains(text(),'继续') or contains(text(),'Continue')]",
            "//button[@type='submit']"
        ]

        for selector in confirm_selectors:
            try:
                btn = driver.find_element(By.XPATH, selector)
                if btn.is_displayed() and btn.is_enabled():
                    btn.click()
                    print("[确认] 点击确认并继续")
                    time.sleep(3)
                    break
            except:
                continue

    except Exception as e:
        print(f"[确认] 处理确认页面出错: {e}")


def handle_authorization_page(driver, wait):
    """处理授权确认页面（确认并继续 / 允许访问）"""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait

    try:
        # 多次尝试，等待页面加载
        for attempt in range(5):
            time.sleep(3)

            page_source = driver.page_source

            # 检查是否有"确认并继续"页面（已请求授权）
            if "确认并继续" in page_source or "Confirm and continue" in page_source or "已请求授权" in page_source:
                print("[授权] 检测到'确认并继续'页面")

                # 尝试点击"确认并继续"按钮
                confirm_selectors = [
                    "//button[contains(text(),'确认并继续')]",
                    "//button[contains(text(),'Confirm and continue')]",
                    "//button[contains(@class,'awsui-button--primary')]",
                    "//button[contains(@class,'primary')]",
                    "//span[contains(text(),'确认并继续')]/parent::button",
                    "//button[@data-testid='confirm-button']",
                    "//button[@type='submit']"
                ]

                for selector in confirm_selectors:
                    try:
                        btns = driver.find_elements(By.XPATH, selector)
                        for btn in btns:
                            if btn.is_displayed() and btn.is_enabled():
                                # 滚动到按钮位置
                                driver.execute_script("arguments[0].scrollIntoView(true);", btn)
                                time.sleep(0.5)
                                btn.click()
                                print("[授权] 点击'确认并继续'")
                                time.sleep(3)

                                # 继续处理"允许"页面
                                handle_allow_page(driver)
                                return
                    except Exception as e:
                        continue

            # 检查是否有"允许"页面
            if "允许" in page_source or "Allow" in page_source:
                handle_allow_page(driver)
                return

            print(f"[授权] 等待授权页面... ({attempt + 1}/5)")

        print("[授权] 未找到授权按钮，可能需要手动确认")

    except Exception as e:
        print(f"[授权] 处理授权页面出错: {e}")


def handle_allow_page(driver):
    """处理'允许'页面"""
    from selenium.webdriver.common.by import By

    try:
        time.sleep(2)
        page_source = driver.page_source

        if "允许" in page_source or "Allow" in page_source:
            print("[授权] 检测到'允许'页面")

            allow_selectors = [
                "//button[contains(text(),'允许')]",
                "//button[contains(text(),'Allow')]",
                "//button[contains(@class,'awsui-button--primary')]",
                "//button[contains(@class,'primary')]",
                "//span[contains(text(),'允许')]/parent::button",
                "//button[@type='submit']"
            ]

            for selector in allow_selectors:
                try:
                    btns = driver.find_elements(By.XPATH, selector)
                    for btn in btns:
                        if btn.is_displayed() and btn.is_enabled():
                            driver.execute_script("arguments[0].scrollIntoView(true);", btn)
                            time.sleep(0.5)
                            btn.click()
                            print("[授权] 点击'允许'")
                            time.sleep(2)
                            return
                except:
                    continue

    except Exception as e:
        print(f"[授权] 处理允许页面出错: {e}")


def save_mfa_secret(email, secret):
    """保存 MFA 秘钥到文件"""
    try:
        try:
            with open(MFA_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except:
            data = {}

        data[email] = {
            "secret": secret,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }

        with open(MFA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        print(f"[MFA] 秘钥已保存到: {MFA_FILE}")
    except Exception as e:
        print(f"[MFA] 保存秘钥失败: {e}")


def get_totp_code(secret):
    """获取 TOTP 验证码（优先本地生成）"""
    # 清理秘钥格式
    secret = secret.strip().replace(" ", "").replace("-", "").upper()

    # 方案1：使用 pyotp 本地生成（推荐）
    try:
        import pyotp
        totp = pyotp.TOTP(secret)
        code = totp.now()
        print(f"[MFA] 本地生成验证码: {code}")
        return code
    except ImportError:
        print("[MFA] pyotp 未安装，尝试在线获取")
    except Exception as e:
        print(f"[MFA] pyotp 生成失败: {e}")

    # 方案2：使用 hmac 手动实现 TOTP
    try:
        import hmac
        import struct
        import base64

        # Base32 解码
        key = base64.b32decode(secret, casefold=True)
        # 当前时间步
        counter = int(time.time()) // 30
        # HMAC-SHA1
        msg = struct.pack(">Q", counter)
        h = hmac.new(key, msg, "sha1").digest()
        # 动态截断
        offset = h[-1] & 0x0F
        code = struct.unpack(">I", h[offset:offset + 4])[0] & 0x7FFFFFFF
        code = str(code % 1000000).zfill(6)
        print(f"[MFA] 手动生成验证码: {code}")
        return code
    except Exception as e:
        print(f"[MFA] 手动生成失败: {e}")

    # 方案3：在线 API 获取
    try:
        url = f"https://2fa.run/2fa/{secret}"
        print(f"[MFA] 在线获取验证码: {url}")
        resp = requests.get(url, timeout=10)
        if resp.ok:
            match = re.search(r'(\d{6})', resp.text)
            if match:
                code = match.group(1)
                print(f"[MFA] 在线获取验证码: {code}")
                return code
    except Exception as e:
        print(f"[MFA] 在线获取失败: {e}")

    print("[MFA] 无法获取验证码，建议安装 pyotp: pip install pyotp")
    return None


class AWSSSOClient:
    """AWS SSO OIDC 客户端"""

    def __init__(self, region="us-east-1"):
        self.region = region
        self.base_url = f"https://oidc.{region}.amazonaws.com"

    def register_device_client(self, issuer_url):
        """注册支持设备授权的客户端"""
        url = f"{self.base_url}/client/register"

        body = {
            "clientName": "Kiro Account Manager",
            "clientType": "public",
            "scopes": [
                "codewhisperer:completions",
                "codewhisperer:analysis",
                "codewhisperer:conversations",
                "codewhisperer:transformations",
                "codewhisperer:taskassist"
            ],
            "grantTypes": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
            "issuerUrl": issuer_url
        }

        print(f"\n[AWS SSO] 注册设备客户端 (region: {self.region})")

        resp = requests.post(url, json=body, headers={"Content-Type": "application/json"})

        if not resp.ok:
            raise Exception(f"设备客户端注册失败 ({resp.status_code}): {resp.text}")

        print("设备客户端注册成功")
        return resp.json()

    def start_device_authorization(self, client_id, client_secret, start_url):
        """发起设备授权请求"""
        url = f"{self.base_url}/device_authorization"

        body = {
            "clientId": client_id,
            "clientSecret": client_secret,
            "startUrl": start_url
        }

        print("\n[AWS SSO] 发起设备授权")

        resp = requests.post(url, json=body, headers={"Content-Type": "application/json"})

        if not resp.ok:
            raise Exception(f"设备授权失败 ({resp.status_code}): {resp.text}")

        print("设备授权已发起")
        return resp.json()

    def poll_device_token(self, client_id, client_secret, device_code):
        """轮询设备授权状态获取 Token"""
        url = f"{self.base_url}/token"

        body = {
            "clientId": client_id,
            "clientSecret": client_secret,
            "grantType": "urn:ietf:params:oauth:grant-type:device_code",
            "deviceCode": device_code
        }

        resp = requests.post(url, json=body, headers={"Content-Type": "application/json"})

        if resp.ok:
            return {"status": "success", "token": resp.json()}

        # 解析错误响应
        try:
            err = resp.json()
            error_code = err.get("error", "")
            if error_code == "authorization_pending":
                return {"status": "pending"}
            elif error_code == "slow_down":
                return {"status": "slow_down"}
            elif error_code == "expired_token":
                return {"status": "expired"}
            elif error_code == "access_denied":
                return {"status": "denied"}
            else:
                raise Exception(f"设备授权错误: {error_code}")
        except json.JSONDecodeError:
            raise Exception(f"轮询失败 ({resp.status_code}): {resp.text}")

    def refresh_token(self, client_id, client_secret, refresh_token):
        """刷新 Token"""
        url = f"{self.base_url}/token"

        body = {
            "clientId": client_id,
            "clientSecret": client_secret,
            "grantType": "refresh_token",
            "refreshToken": refresh_token
        }

        print("\n[AWS SSO] 刷新 Token")

        resp = requests.post(url, json=body, headers={"Content-Type": "application/json"})

        if not resp.ok:
            if resp.status_code == 401:
                raise Exception("RefreshToken 已过期或无效")
            raise Exception(f"Token 刷新失败 ({resp.status_code}): {resp.text}")

        print("Token 刷新成功")
        return resp.json()


def idc_login(start_url, region="us-east-1", email="", password="", headless=False):
    """
    IdC/企业登录流程
    使用 Device Authorization Flow + Selenium 自动登录
    """
    print(f"\n[IdC] 开始企业登录...")
    print(f"Region: {region}")
    print(f"Start URL: {start_url}")

    # Step 1: 创建 AWS SSO 客户端
    sso_client = AWSSSOClient(region)

    # Step 2: 注册设备客户端
    print("\n[IdC] 注册设备客户端...")
    client_reg = sso_client.register_device_client(start_url)
    client_id = client_reg["clientId"]
    client_secret = client_reg["clientSecret"]
    print(f"Client ID: {client_id}")

    # Step 3: 发起设备授权
    print("\n[IdC] 发起设备授权...")
    device_auth = sso_client.start_device_authorization(client_id, client_secret, start_url)

    user_code = device_auth["userCode"]
    verification_uri = device_auth["verificationUri"]
    verification_uri_complete = device_auth.get("verificationUriComplete", verification_uri)
    expires_in = device_auth["expiresIn"]
    interval = device_auth.get("interval", 5)

    print(f"\n[IdC] User Code: {user_code}")
    print(f"[IdC] Verification URI: {verification_uri}")

    # Step 4: 使用 Selenium 自动登录
    driver = None
    mfa_secret = None
    if email and password:
        print(f"\n[IdC] 使用 Selenium 自动登录...")
        driver, mfa_secret = auto_login_with_selenium(verification_uri_complete, email, password, headless=headless)

        # 检查是否是凭证验证失败
        if mfa_secret == "CREDENTIAL_ERROR":
            if driver:
                try:
                    driver.quit()
                except:
                    pass
            raise Exception("CREDENTIAL_ERROR: 无法验证登录凭证")
    else:
        # 手动打开浏览器
        import webbrowser
        print(f"\n[IdC] 打开浏览器: {verification_uri_complete}")
        webbrowser.open(verification_uri_complete)
        print("\n请在浏览器中完成登录授权...")
        print(f"如果没有自动打开，请手动访问: {verification_uri}")
        print(f"并输入代码: {user_code}")

    # Step 5: 轮询等待用户授权
    print("\n[IdC] 等待用户授权...")
    timeout = time.time() + expires_in
    device_code = device_auth["deviceCode"]

    while time.time() < timeout:
        time.sleep(interval)

        result = sso_client.poll_device_token(client_id, client_secret, device_code)
        status = result["status"]

        if status == "success":
            print("\n[IdC] 授权成功!")
            token_response = result["token"]
            break
        elif status == "pending":
            print(".", end="", flush=True)
            continue
        elif status == "slow_down":
            interval += 5
            continue
        elif status == "expired":
            raise Exception("设备码已过期，请重试")
        elif status == "denied":
            raise Exception("用户拒绝授权")
    else:
        raise Exception("设备授权超时，请重试")

    # Step 6: 构建结果
    expires_at = datetime.now() + timedelta(seconds=token_response["expiresIn"])
    client_id_hash = compute_client_id_hash(start_url)

    auth_result = {
        "accessToken": token_response["accessToken"],
        "refreshToken": token_response["refreshToken"],
        "expiresAt": expires_at.strftime("%Y/%m/%d %H:%M:%S"),
        "expiresIn": token_response["expiresIn"],
        "idToken": token_response.get("idToken"),
        "tokenType": token_response.get("tokenType"),
        "authMethod": "IdC",
        "region": region,
        "startUrl": start_url,
        "email": email,
        "clientId": client_id,
        "clientSecret": client_secret,
        "clientIdHash": client_id_hash,
        "ssoSessionId": token_response.get("aws_sso_app_session_id"),
        "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }

    # 关闭浏览器
    if driver:
        try:
            driver.quit()
            print("[Selenium] 浏览器已关闭")
        except:
            pass

    print(f"\n[IdC] 登录成功!")
    print(f"过期时间: {auth_result['expiresAt']}")

    return auth_result


def save_token_result(result, output_file=None):
    """保存单个 Token 结果"""
    output_file = output_file or TOKEN_FILE
    try:
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"[保存] Token 已保存到: {output_file}")
        return True
    except Exception as e:
        print(f"[保存] 保存失败: {e}")
        return False


def save_batch_results(results, output_file=None):
    """保存批量 Token 结果"""
    output_file = output_file or BATCH_TOKEN_FILE
    try:
        # 读取已有结果
        existing = []
        if Path(output_file).exists():
            try:
                with open(output_file, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except:
                existing = []

        # 合并结果（按 email 去重更新）
        email_map = {r.get("email"): r for r in existing}
        for result in results:
            email = result.get("email")
            if email:
                email_map[email] = result

        merged = list(email_map.values())

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)

        print(f"[保存] 批量结果已保存到: {output_file} (共 {len(merged)} 条)")
        return True
    except Exception as e:
        print(f"[保存] 批量保存失败: {e}")
        return False


def batch_login(accounts, delay=5, headless=False):
    """批量登录多个账号，每个账号保存为 邮箱.json"""
    results = []
    success_count = 0
    fail_count = 0

    total = len(accounts)
    print(f"\n{'='*50}")
    print(f"开始批量登录，共 {total} 个账号")
    print(f"{'='*50}")

    for i, account in enumerate(accounts, 1):
        email = account.get("email", f"账号{i}")
        print(f"\n[{i}/{total}] 处理账号: {email}")
        print("-" * 40)

        try:
            result = idc_login(
                start_url=account["start_url"],
                region=account.get("region", "us-east-1"),
                email=account.get("email", ""),
                password=account.get("password", ""),
                headless=headless
            )
            result["status"] = "success"
            results.append(result)
            success_count += 1
            print(f"[{i}/{total}] {email} 登录成功")

            # 保存为 邮箱.json 文件
            if email:
                email_file = BASE_DIR / f"{email}.json"
                save_token_result(result, email_file)

        except Exception as e:
            error_msg = str(e)
            print(f"[{i}/{total}] {email} 登录失败: {error_msg}")

            # 如果是凭证验证失败，删除该行
            if "CREDENTIAL_ERROR" in error_msg:
                original_line = account.get("original_line", "")
                if original_line:
                    print(f"[{i}/{total}] 凭证无效，从账号文件中删除该行...")
                    delete_account_line(original_line)

            results.append({
                "email": email,
                "startUrl": account.get("start_url"),
                "status": "failed",
                "error": error_msg,
                "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
            fail_count += 1

        # 账号间延迟
        if i < total and delay > 0:
            print(f"\n等待 {delay} 秒后处理下一个账号...")
            time.sleep(delay)

    # 保存批量结果（备份）
    save_batch_results(results)

    # 调用 merge_tokens.py 合并所有 邮箱.json 文件
    print(f"\n[合并] 调用 merge_tokens.py 合并所有 token 文件...")
    try:
        import subprocess
        merge_script = BASE_DIR / "merge_tokens.py"
        if merge_script.exists():
            subprocess.run([sys.executable, str(merge_script)], cwd=str(BASE_DIR))
        else:
            print(f"[合并] merge_tokens.py 不存在，跳过合并")
    except Exception as e:
        print(f"[合并] 合并失败: {e}")

    print(f"\n{'='*50}")
    print(f"批量登录完成: 成功 {success_count}, 失败 {fail_count}, 共 {total}")
    print(f"{'='*50}")

    return results


def loop_login(delay=5, headless=False):
    """循环登录模式：每次读取第一行，处理后删除，直到文件为空"""
    success_count = 0
    fail_count = 0
    round_num = 0

    print(f"\n{'='*50}")
    print(f"开始循环登录模式")
    print(f"{'='*50}")

    while True:
        round_num += 1
        # 每次重新读取账号文件，获取第一个账号
        accounts = load_accounts()

        if not accounts:
            print(f"\n[循环] 账号文件已空，循环结束")
            break

        account = accounts[0]
        email = account.get("email", f"账号{round_num}")
        remaining = len(accounts)

        print(f"\n[第{round_num}轮] 处理账号: {email} (剩余 {remaining} 个)")
        print("-" * 40)

        try:
            result = idc_login(
                start_url=account["start_url"],
                region=account.get("region", "us-east-1"),
                email=account.get("email", ""),
                password=account.get("password", ""),
                headless=headless
            )
            success_count += 1
            print(f"[第{round_num}轮] {email} 登录成功")

            # 保存为 邮箱.json 文件
            if email:
                email_file = BASE_DIR / f"{email}.json"
                save_token_result(result, email_file)

            # 登录成功，删除该行
            original_line = account.get("original_line", "")
            if original_line:
                print(f"[第{round_num}轮] 登录成功，从账号文件中删除该行...")
                delete_account_line(original_line)

        except Exception as e:
            error_msg = str(e)
            print(f"[第{round_num}轮] {email} 登录失败: {error_msg}")
            fail_count += 1

            # 删除该行（无论什么错误都删除，继续下一个）
            original_line = account.get("original_line", "")
            if original_line:
                print(f"[第{round_num}轮] 从账号文件中删除该行...")
                delete_account_line(original_line)

        # 延迟后继续下一个
        if delay > 0:
            print(f"\n等待 {delay} 秒后处理下一个账号...")
            time.sleep(delay)

    # 调用 merge_tokens.py 合并所有 邮箱.json 文件
    print(f"\n[合并] 调用 merge_tokens.py 合并所有 token 文件...")
    try:
        import subprocess
        merge_script = BASE_DIR / "merge_tokens.py"
        if merge_script.exists():
            subprocess.run([sys.executable, str(merge_script)], cwd=str(BASE_DIR))
        else:
            print(f"[合并] merge_tokens.py 不存在，跳过合并")
    except Exception as e:
        print(f"[合并] 合并失败: {e}")

    print(f"\n{'='*50}")
    print(f"循环登录完成: 成功 {success_count}, 失败 {fail_count}, 共处理 {round_num} 轮")
    print(f"{'='*50}")

    return success_count, fail_count


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description="Kiro IdC/IAM Identity Center 登录工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  使用默认账号文件登录第一个账号
  python kiro_idc_login.py

  # 批量登录所有账号
  python kiro_idc_login.py --batch

  # 指定账号文件
  python kiro_idc_login.py -f accounts.txt --batch

  # 直接指定账号信息
  python kiro_idc_login.py --url https://xxx.awsapps.com/start --email user@example.com --password xxx

  # 设置批量登录间隔
  python kiro_idc_login.py --batch --delay 10

账号文件格式 (每行一个账号):
  start_url----region----email----password
  https://xxx.awsapps.com/start----us-east-1----user@example.com----password123
        """
    )

    parser.add_argument("-f", "--file", type=str, help="账号文件路径")
    parser.add_argument("--batch", action="store_true", help="批量登录所有账号")
    parser.add_argument("--loop", action="store_true", help="循环登录模式：逐行处理，处理后删除该行")
    parser.add_argument("--delay", type=int, default=5, help="批量登录时账号间延迟秒数 (默认: 5)")
    parser.add_argument("--url", type=str, help="Start URL")
    parser.add_argument("--region", type=str, default="us-east-1", help="AWS Region (默认: us-east-1)")
    parser.add_argument("--email", type=str, help="登录邮箱")
    parser.add_argument("--password", type=str, help="登录密码")
    parser.add_argument("-o", "--output", type=str, help="输出文件路径")
    parser.add_argument("--headless", action="store_true", help="无头模式运行浏览器")
    parser.add_argument("--no-auto", action="store_true", help="不自动登录，手动在浏览器中操作")

    return parser.parse_args()


def main():
    args = parse_args()

    # 直接指定账号信息
    if args.url:
        account = {
            "start_url": args.url,
            "region": args.region,
            "email": args.email or "",
            "password": args.password or "",
        }
        if args.no_auto:
            account["email"] = ""
            account["password"] = ""

        print(f"Start URL: {account['start_url']}")
        print(f"Region: {account['region']}")
        print(f"Email: {account['email'] or '(手动登录)'}")

        try:
            result = idc_login(**account, headless=args.headless)
            output_file = args.output or TOKEN_FILE
            save_token_result(result, output_file)
        except Exception as e:
            print(f"\n登录失败: {e}")
            sys.exit(1)
        return

    # 从文件加载账号
    account_file = args.file or ACCOUNT_FILE
    accounts = load_accounts(account_file)

    if not accounts:
        print("无法加载账号信息")
        sys.exit(1)

    # 批量登录
    if args.batch:
        batch_login(accounts, delay=args.delay, headless=args.headless)
        return

    # 循环登录模式
    if args.loop:
        loop_login(delay=args.delay, headless=args.headless)
        return

    # 单个账号登录（第一个）
    account = accounts[0]
    if args.no_auto:
        account["email"] = ""
        account["password"] = ""

    print(f"Start URL: {account['start_url']}")
    print(f"Region: {account['region']}")
    print(f"Email: {account['email'] or '(手动登录)'}")

    try:
        result = idc_login(
            start_url=account["start_url"],
            region=account["region"],
            email=account["email"],
            password=account["password"],
            headless=args.headless
        )
        output_file = args.output or TOKEN_FILE
        save_token_result(result, output_file)

    except Exception as e:
        error_msg = str(e)
        print(f"\n登录失败: {error_msg}")

        # 如果是凭证验证失败，删除该行
        if "CREDENTIAL_ERROR" in error_msg:
            original_line = account.get("original_line", "")
            if original_line:
                print(f"凭证无效，从账号文件中删除该行...")
                delete_account_line(original_line)

        sys.exit(1)


if __name__ == "__main__":
    main()
